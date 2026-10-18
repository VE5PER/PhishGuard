# Deploying PhishGuard on Dokploy

> Status: backend + datastores run as containers; the Chrome extension is built
> and distributed as a **separate** Dokploy application.

---

## 1. What the code actually needs (analysis)

The repository today is **not** the DuckDB + Postgres architecture described in
the brief. Current truth:

| Piece | Where | Deployable? | Notes |
| --- | --- | --- | --- |
| FastAPI gateway | `apps/backend` | ✅ container | `POST /v1/escalate`, `GET /health`, `/download/*`, `/v1/models/*/download`. |
| Artifact storage | RustFS | 🌐 external | S3-compatible object storage hosted on external system, reached via `RUSTFS_ENDPOINT_URL`. |
| Reputation cache | `services/cache.py` | in-process | `dict` with TTL; Redis is only a documented intention. |
| Auth | `services/auth.py` | in-process | `dev_mode=True` **hardcoded**; keys hardcoded. |
| Cloud inference | `services/cloud_inference.py` | in-process | `torch` CPU + `phishguard-ml-engine` (CNN+BiLSTM). |
| Shared types | `packages/types` | library | Pydantic v2 (py) + Zod (ts). |
| ML engine | `packages/ml-engine` | library | Needs `torch`, `numpy` at runtime. `scipy`/`scikit-learn` are declared but never imported. |
| Chrome extension | `apps/extension` | ❌ not a server | MV3 bundle; loaded unpacked / Web Store. No DuckDB yet. |
| Postgres | — | absent | No `psycopg`/SQLAlchemy/Alembic/DATABASE_URL anywhere. |
| Redis | — | absent | Only a comment in `apps/backend/AGENTS.md`. |
| DuckDB | — | absent | Not in extension or backend. Intended as in-browser DuckDB-WASM. |

**Consequences for the compose file**

1. Postgres and Redis are provisioned with volumes + healthchecks and the
   gateway receives `DATABASE_URL` / `REDIS_URL`.
2. RustFS provides distributed S3-compatible artifact storage (hosted externally)
   for ONNX model binaries, extension `.zip`/`.crx` distribution files, and forensic payloads.
3. The gateway image deliberately installs the workspace packages with
   `--no-deps` and adds only `numpy`, `httpx` + CPU `torch`, skipping `scipy` and
   `scikit-learn` (~700 MB saved, both unused at runtime).
4. The gateway runs **one uvicorn worker** because the reputation cache is
   in-memory; multiple workers would diverge. Move the cache to Redis before
   scaling out.
5. `AUTH_DEV_MODE` is passed but **ignored by the current code**. Do not put the
   gateway on a public domain until auth is wired up (see §6).

---

## 2. Files added

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | gateway stack for Dokploy (managed DB/Redis + external RustFS). |
| `.env.example` | Template for secrets/config; copy to `.env`. |
| `apps/backend/Dockerfile` | Slim CPU-torch FastAPI image, non-root, healthcheck. |
| `apps/backend/src/phishguard_backend/services/storage.py` | RustFS S3-compatible client with SigV4 auth, streaming, & local sync. |
| `apps/extension/Dockerfile` | Build + nginx distribution app for the extension. |
| `deploy/extension/index.html` | Landing page with the download link. |
| `deploy/postgres/init/00_init.sql` | First-boot extensions + `phishguard` schema. |
| `.dockerignore` | Keeps node_modules/.venv/weights/secrets out of images. |

---

## 3. Target topology

```
                 Internet / users
                        │  HTTPS
                ┌───────▼────────┐
                │ Dokploy Traefik│  (managed by Dokploy)
                └───┬────────┬───┘
        gateway.<domain>   extension.<domain>
                │                    │
     ┌──────────▼─────────┐   ┌──────▼───────────────┐
     │ gateway (FastAPI)  │   │ extension-dist (nginx)│
     │ :8000              │   │ :80  static + .zip    │
     └───┬──────────┬─────┴───┬───────────────────────┘
         │          │         │
   ┌─────▼────┐ ┌───▼────┐ ┌──▼───────────┐
   │ postgres │ │ redis  │ │ rustfs (S3)  │   external / managed
   │ :5432    │ │ :6379  │ │ (remote)     │
   └──────────┘ └────────┘ └──────────────┘
```

Only Traefik is internet-facing. Postgres and Redis are reached on the `dokploy-network` internal network; RustFS is reached via `RUSTFS_ENDPOINT_URL`; the gateway container consumes them directly.

---

## 4. Deploy the gateway stack in Dokploy

Each environment is its own Dokploy Compose service pointing at its branch and
its env template. See [`deploy/README.md`](./README.md) for the env↔branch map.

1. **Push this repo** (with the new files) to your Git remote.
2. In Dokploy: **Create Project → Compose**.
   - Provider: your Git repo (GitHub/GitLab).
   - Branch: `dev-1`, `dev-2`, or `main` (prod).
   - Compose path: `docker-compose.yml` (shared by all envs).
   - Compose type: **Docker Compose** (build from repo).
3. **Environment**: open the service’s Environment editor and paste the matching
   template from `deploy/env/`:
   - `dev-1` branch → `deploy/env/.env.dev-1.example`
   - `dev-2` branch → `deploy/env/.env.dev-2.example`
   - `main` branch → `deploy/env/.env.prod.example`

   Replace every `CHANGE_ME_*` with strong secrets. Compose reads `.env` for
   `${...}` interpolation automatically, and `COMPOSE_PROJECT_NAME` namespaces
   containers/volumes so both developers can share one host.
4. **Domain**: in the *Domains* tab add `phishguard-gateway.<yourdomain>` with
   container port `8000`, HTTPS + Let's Encrypt. Dokploy writes the Traefik
   labels for you (the labels block in `docker-compose.yml` is a manual
   alternative — use one or the other, not both).
5. **Deploy**. Watch the build; first build downloads the CPU torch wheel
   (~200 MB) so allow a few minutes.
6. **Verify**:
   ```bash
   curl -fsS https://phishguard-gateway.<yourdomain>/health
   # {"status":"healthy","service":"phishguard-backend","version":"0.1.0"}
   ```
7. Make the extension point at it — see §5.

> `dokploy-network` is declared `external: true`. Dokploy creates it with
> Traefik. Running this compose outside Dokploy fails unless you
> `docker network create dokploy-network` or delete that network entry.

### Local Development Stack (Self-Contained with All Dependencies)

For local development where you want all dependencies (`postgres`, `redis`, `rustfs`, and `gateway`) running together without requiring Dokploy:

```bash
cp .env.local.example .env
pnpm compose:local                         # bumps the extension patch version, then builds and starts
# docker compose -f docker-compose.local.yml up -d --build   # same, without a version bump
curl -fsS http://localhost:8010/health    # dev-1 uses port 8010
docker compose -f docker-compose.local.yml down
```

The local API stack packages the already released 1.5.0 model. Missing legacy
metadata is recovered only when its binary matches the exact released model;
this does not claim student-v2 validation. Student-v2 packaging requires a
matching metadata sidecar and versioned validation reports.

### Dokploy Compose Validation (before Dokploy deployment)

To validate the Dokploy-specific compose file (`docker-compose.yml`):

```bash
cp deploy/env/.env.dev-1.example .env     # or inspect interpolation
docker network create dokploy-network       # only if not running Dokploy
docker compose config                       # validate interpolation
docker compose build gateway
```

Exercise escalation (matches `apps/backend/tests`):

```bash
curl -sS http://localhost:8000/v1/escalate \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test_client_key' \
  -d '{"telemetryId":"11111111-1111-1111-1111-111111111111",
       "url":"https://login.microsoftonline.com.secure-update.xyz/",
       "domain":"login.microsoftonline.com.secure-update.xyz",
       "clientRiskScore":0.5,"mouseTrajectorySeries":[],
       "domElementsSummary":[],"keystrokesSummary":[],
       "clientTimestamp":"2026-01-01T00:00:00Z"}'
```

---

## 5. Deploy the extension as a separate Dokploy app

The extension is client-side, so it can’t be a routed API. Treat it as a build
job + static host:

1. In Dokploy: **Create Project → Application** (or Compose) pointing at this
   same repo.
2. Build type: **Dockerfile**.
   - Dockerfile path: `apps/extension/Dockerfile`
   - Build context: **repository root**.
3. Add domain `phishguard-extension.<yourdomain>`, container port `80`.
   The build packages locally with `--local-only`; it does not upload extension
   artifacts to RustFS. Student-v2 packaging requires the bundled model and
   matching metadata sidecar plus validation reports under
   `apps/backend/models/v<model-version>/`.
4. Set the **Build-time Arguments** (Application → Environment → Build-time Arguments):

   ```
   BACKEND_URL=https://phishguard-gateway.<yourdomain>
   ```

   and the **Build-time Secrets** (Application → Environment → Build-time Secrets):

   ```
   EXTENSION_SIGNING_KEY_B64=<base64 of phishguard-extension.pem>
   ```

   Produce the value from the local, untracked key with
   `base64 -w0 deploy/extension/phishguard-extension.pem`. The build fails if the
   secret is missing or if its key does not match the manifest `key`
   (extension ID `loanjnnlfhechkonbjelmbdacmmcbagg`); a key is never generated
   automatically because a new key means a new extension ID.
   `BACKEND_URL` must be `https://` in deployed environments. It is the single env var
   for reaching the backend gateway, supplying endpoints for download, update, escalate,
   and health diagnostics. Templates: `deploy/env/.env.*.example`.
5. Deploy. The build writes `update_url = <base>/download/updates.xml` into the
   packaged manifest and an `updates.xml` with an absolute, version-pinned CRX URL.
   Users download either:
   - `https://phishguard-extension.<yourdomain>/download/phishguard-extension.crx`
     and drag-and-drop directly into `chrome://extensions` with Developer mode ON (recommended, 0 unzipping).
     Chrome then updates it automatically on **Linux**, and on Windows/macOS only when
     installed by enterprise policy (below).
   - `https://phishguard-extension.<yourdomain>/download/phishguard-extension.zip`
     and install via `chrome://extensions → Load unpacked` (never auto-updates; the
     extension offers "Download zip" and you unzip over the folder).
   - `https://phishguard-extension.<yourdomain>/download/phishguard-extension-webstore.zip`
     is the Chrome Web Store upload package (manifest without `key` / `update_url`).

**Enterprise policy for Windows/macOS managed devices.** Chrome only auto-updates
self-hosted CRXs there when force-installed. Add to `ExtensionInstallForcelist`:

```
loanjnnlfhechkonbjelmbdacmmcbagg;https://phishguard-extension.<yourdomain>/download/updates.xml
```

**Migration from v0.2.0.** v0.2.0 installs have no `update_url`; install the 0.3.0
CRX once over the old one (no uninstall, settings are kept). Later updates are
automatic and the extension shows a one-click "Restart to update".

**Point the client at the deployed gateway.** The client build uses `BACKEND_URL` as the
single environment variable for reaching the backend gateway:
- Cloud escalation (`${BACKEND_URL}/v1/escalate`)
- Student model update checks and downloads (`${BACKEND_URL}/v1/models/*`)
- Extension releases and package downloads (`${BACKEND_URL}/download/*`)
- Gateway health diagnostics (`${BACKEND_URL}/health`)

Pass `BACKEND_URL=https://phishguard-gateway.<yourdomain>` when building the extension or gateway image.
For prod, `BACKEND_URL` is `https://phishguard-gateway-prod-<PROJECT_NUMBER>.<REGION>.run.app`
(set via `GATEWAY_DOMAIN` in `deploy/env/.env.prod.example`).

### Dataset agent (dormant batch worker)

The dataset agent runs as a **one-shot** aggregation job, not a long-lived
service. In `docker-compose.yml` it is gated behind the `dataset-agent`
profile, so a plain `docker compose up` never starts it:

```bash
# Build once, then run a single aggregation cycle on demand
docker compose --profile dataset-agent build dataset-agent
docker compose --profile dataset-agent run --rm dataset-agent
```

- Output lands in the named volume `dataset_data` (`/app/data` →
  `daily_datasets/YYYY-MM-DD/` plus the ML lifecycle export dir).
- All `DATASET_AGENT_*` env vars come from the same `.env` template block
  (see `deploy/env/.env.<env>.example`).
- `GEMINI_API_KEY` is optional. Deep Research stays off unless
  `DATASET_AGENT_DEEP_RESEARCH_ENABLED=true` **and** a key is set — each task
  is a paid Gemini call (~$1–3, up to an hour).
- The gateway also uses `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) for the Gemini ADK
  cloud teacher behind `POST /v1/escalate`, `POST /v1/escalate/gemini` and the landing-page playground
  (`GEMINI_TEACHER_ENABLED`, `GEMINI_TEACHER_MODEL`, `GEMINI_TEACHER_TIMEOUT_S`,
  `GEMINI_TEACHER_MAX_CALLS_PER_HOUR` — a global hourly cap, default 200; Vertex mode
  via `GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`).
  When configured, `POST /v1/escalate` uses Gemini (skipping neutral known-benign hosts) and forwards
  the opt-in consented screenshot to the Gemini API; unconfigured it stays deterministic
  `cloud-evidence-v2`. A missing or
  `CHANGE_ME_*` key leaves the teacher off, and Gemini failures, an open circuit or an
  exhausted budget fall back to the heuristics (`cloud-evidence-v2-fallback`).
  `/health` reports `cloudTeacher`.

**DuckDB analytics (future).** DuckDB belongs in the client as
`@duckdb/duckdb-wasm`, running in the service worker / offscreen document to
aggregate local telemetry. It needs **no container**. If you later want a
server-side analytics UI, that is a new web app container reading Postgres
(or BigQuery on GCP) — separate from the extension.

---

### Extension signing key for the gateway build

The gateway image also packages the extension (signed CRX, zips and `updates.xml` served at `/download/*`),
so its build needs the same CRX signing key as the extension app. Compose passes it as a BuildKit secret
(`secrets: EXTENSION_SIGNING_KEY_B64`, read from the build environment or `.env`) plus the build arg
`BACKEND_URL`. In Dokploy add `EXTENSION_SIGNING_KEY_B64` under **Build-time Secrets** for the
gateway compose app (and `BACKEND_URL` as a build/environment variable). Locally, run
`scripts/bootstrap.sh` (or `scripts/extension_key.py export-env`) to write it to `.env`.
Both Dockerfiles invoke the packager with `--local-only`, so container builds
do not upload extension artifacts to RustFS.

### Vision (consented screenshots)

The gateway embeds a user-consented screenshot with MobileNetV3-Small and
compares it with the brand gallery in `apps/backend/assets/brand_gallery/<brand>/`
(operators may drop official screenshots into those folders). The weights are
pre-downloaded into the image (`TORCH_HOME=/app/.cache/torch`), so no network
is needed at runtime. The gateway service runs with `mem_limit: 2g`.
Screenshots are never persisted (audit records, cache) or logged; when the Gemini teacher is configured they are also forwarded to the Gemini API.

## 6. Blockers to clear before public exposure

1. **Auth is a POC stub.** `AUTH_DEV_MODE` is not read; `dev_mode=True` and the
   API keys are hardcoded in `services/auth.py`. Wire `AUTH_DEV_MODE` /
   `PHISHGUARD_API_KEYS` from env and set `dev_mode=False` in production.
2. **CORS is `allow_origins=["*"]` with credentials** in `main.py`. Chrome
   extensions send `Origin: chrome-extension://<id>`; tighten to the actual
   extension ID (or `*` without credentials) before launch.
3. **In-memory cache + single worker.** Fine for POC, but restart loses state
   and horizontal scaling breaks dedup. Implement the Redis cache.
4. **No persistence/audit.** `DATABASE_URL` is injected but unused; add
   SQLAlchemy + Alembic and write escalation audits when ready.
5. **`/docs` is public.** Consider disabling OpenAPI in production.
6. **Secrets in Dokploy only.** Never commit `.env` (already gitignored).

---

## 7. Migration path to GCP (when stable)

| Component | GCP target | Notes |
| --- | --- | --- |
| Gateway | **Cloud Run** | Same `apps/backend/Dockerfile`; it’s already stateless. Push to Artifact Registry. Set min-instances ≥ 1 to avoid cold-start torch model construction. |
| Postgres | **Cloud SQL for PostgreSQL** | Use the Cloud SQL connector / Auth Proxy from Cloud Run; point `DATABASE_URL` at it. |
| Redis | **Memorystore for Redis** | Point `REDIS_URL` at it. |
| Secrets | **Secret Manager** | Replace Dokploy env with `--set-secrets`. |
| Extension | unchanged | Still Chrome Web Store / enterprise policy. |
| Analytics (if server-side) | **BigQuery** | DuckDB-WASM stays in-browser for local aggregates; ship anonymized rollups to BigQuery. |
| TLS/DNS | **External HTTPS LB / Cloud DNS** | Replaces Traefik. |

Migration is mostly: build the same image → push → `gcloud run deploy` →
swap env vars. No code restructuring required, because the gateway is already
stateless.

---

## 8. Verification checklist

- [ ] `docker compose config` resolves with your `.env`.
- [ ] `docker compose build gateway` succeeds.
- [ ] `/health` returns `healthy` behind Traefik.
- [ ] `POST /v1/escalate` returns a `CloudInferenceVerdict` (200).
- [ ] Postgres/Redis ports are **not** reachable from the host/internet.
- [x] Extension CRX and ZIP download, signed with deterministic ID `loanjnnlfhechkonbjelmbdacmmcbagg`, and install directly into Chrome.
- [ ] Escalation URL in `service-worker.ts` points at the deployed gateway.

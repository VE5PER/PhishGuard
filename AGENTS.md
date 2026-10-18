# PhishGuard: Agent Directives & Architecture Guide

Welcome to **PhishGuard**, an on-device and cloud-tiered behavioral fraud and phishing detection system. This document enforces architectural principles, coding conventions, privacy rules, and testing standards across all autonomous agents and contributors.

---

## 1. System Architecture Overview

PhishGuard evaluates web pages across three synchronized behavioral and perceptual streams:
1. **User Interaction Dynamics:** Pointer trajectories $(x, y, dx, dy, v, a, \theta)$, keystroke flight/dwell timings (strictly privacy-preserving; zero raw character capture), and clipboard paste events.
2. **Screen Behavior & DOM Topology:** Element coordinates, transparent/invisible elements (`opacity: 0`), cross-origin iframes, and credential input zones.
3. **Visual Perception:** Viewport screenshots ($256 \times 256$ / $384 \times 384$), brand logo grounding, and UI layout heuristics.

### The Two Synchronized Streams
- **Stream 1 (App Tier):** 
  - `apps/extension`: Manifest V3 browser extension running an INT8 distilled student model in WebGPU / WASM with tri-state routing.
  - `apps/backend`: FastAPI cloud escalation gateway with domain reputation cache and cloud teacher dispatcher.
  - `apps/landing`: Next.js 14 conversion landing page and web installer.
  - `apps/ml-lifecycle`: ML training lifecycle orchestration, checkpoint storage hierarchy, validation gates, ONNX compilation, and release promotion.
  - `apps/dataset-agent`: Autonomous daily web search and multimodal dataset aggregator agent for model retraining.
- **Stream 2 (ML Tier):**
  - `packages/ml-engine`: PyTorch training, Bézier curve trajectory synthesis, 1D-CNN + BiLSTM behavioral encoder, multimodal teacher model, and ONNX export.
  - `packages/types`: Shared Zod (TypeScript) and Pydantic v2 (Python) data contracts.

---

## 2. Tri-State Decision Routing

The extension's on-device inference engine evaluates all interactions against calibrated risk probabilities:

| Risk Score Range | Decision Action | Action Taken |
| :--- | :--- | :--- |
| **`Score < 0.15`** | **`SAFE`** | Completely silent. Zero network overhead or server pings. |
| **`0.15 <= Score <= 0.85`** | **`AMBIGUOUS`** | Asynchronously packages `EscalationPayload` and dispatches to FastAPI `POST /v1/escalate`. |
| **`Score > 0.85`** | **`BLOCK`** | Immediate client-side block. Halts interaction and renders on-screen warning banner. |

---

## 3. Strict Development Conventions

### A. Spec-Driven Development & Dual Schema Parity
- **No Implicit `any`:** Strict TypeScript typing (`strict: true`, `noImplicitAny: true`).
- **Dual Schema Parity:** Any schema change must be made synchronously in:
  - TypeScript: `packages/types/src/ts/` (using Zod)
  - Python: `packages/types/src/py/phishguard_types/` (using Pydantic v2)
- Unit tests in `packages/types` must pass before modifying consumer applications.

### B. Privacy-Preserving Telemetry (GDPR / PCI-DSS Enforced)
- **NEVER** capture raw character codes, key labels, or text inputs from user keystrokes.
- Only record inter-key flight durations, dwell times, and generalized categories (`ALPHANUMERIC`, `BACKSPACE`, `CONTROL`, `OTHER`).
- Extra fields attempting to log sensitive data are rejected by Pydantic and Zod (`extra="forbid"`).

### C. Execution Sandbox & Automated Verification
Every task or modification must conclude with passing automated tests:
- **Python Tests (Linux):** `.venv/bin/python -m pytest packages/types packages/ml-engine apps/backend apps/ml-lifecycle apps/dataset-agent -v` (Windows: `.\.venv\Scripts\python.exe ...`).
- **TypeScript Tests:** `pnpm test` (build `@phishguard/types` first — consumers import its `dist/`).
- **Type Checking:** `pnpm typecheck`
- **Extension Build:** `pnpm build`
- **Packaging contract tests:** `.venv/bin/python -m pytest scripts/tests -v` (no torch; validates Dockerfile/version/packaging rules).

---

## 4. Monorepo Navigation & Tooling

- **Root:** `pnpm` workspaces (`apps/*`, `packages/*`).
- **Python Virtualenv:** `.venv` powered by `uv` with Python 3.12. On Linux run `.venv/bin/python`; on Windows `.\.venv\Scripts\python.exe`.
- **Node/pnpm:** Node v20+, pnpm 9 (lockfile v9). `pnpm` may not be installed — use `corepack enable` or `npx pnpm@9 ...`.
- **Bootstrap:** `scripts/bootstrap.sh` checks prerequisites, creates `.env`, installs deps, and prepares the extension signing key (idempotent).
- **Version bump:** `pnpm build` runs `scripts/bump-version.mjs`, which rewrites `version.json`, workspace `package.json`s, `apps/extension/manifest.json`, the popup HTML fallback, and `apps/landing/lib/facts.ts`. Set `PHISHGUARD_SKIP_VERSION_BUMP=1` in Docker/CI; review the diff before committing.

---

## 5. Model Artifacts & Extension Packaging

- The released v2.0.0 INT8 model (`student_model.onnx`) **is committed** at `apps/extension/public/models/` and `apps/backend/models/v2.0.0/` (force-added), alongside its metadata sidecar (`apps/extension/public/models/student_model.metadata.json`). `*.onnx` stays gitignored so new candidates aren't committed by accident.
- `scripts/package_extension.py` **requires** the model and validates its SHA-256, size, and input contract against `apps/backend/models/v<version>/` reports. `scripts/tests/test_package_extension.py` enforces this — do not make packaging tolerate a missing/mismatched model.
- Builds fetch the model when it is absent via the `STUDENT_MODEL_URL` build arg (`--build-arg`). Cloud Build passes `_MODEL_URL`; Dokploy/Compose pass `STUDENT_MODEL_URL` (all `deploy/env/.env.*.example` templates set it). Point it at the released v2.0.0 ONNX in RustFS/GCS.
- The CRX signing key is a **BuildKit secret** `EXTENSION_SIGNING_KEY_B64` (base64 PEM). It is never committed or auto-generated — a new key changes the extension ID and breaks updates. Manage it with `scripts/extension_key.py`.
- Distribution artifacts (unpacked `.zip`, Web Store `.zip`, signed `.crx`, `updates.xml`, `extension-meta.json`) are published by the `frontend-builder` stage and served by the gateway from RustFS with local-disk fallback (`apps/backend/src/phishguard_backend/main.py`, `services/storage.py`).

---

## 6. Git Operations Safety Constraint

**UI CONFIRMATION FOR GIT COMMANDS:**
Modifying Git commands (including `git add`, `git commit`, `git push`, `git pull`, `git checkout`, `git switch`, `git merge`, `git rebase`, `git reset`, `git revert`, `git stash`, `git branch`, `git clean`) require user confirmation via the environment's execution permission prompt.

When proposing a modifying Git command:
1. Propose the exact Git command line directly via the command execution tool (`run_command`).
2. Clearly explain what files are changing and why in the accompanying response.
3. Do not wait for verbal/chat confirmation (such as typing "yes" in chat). Propose the command directly so the user can select Approve or Deny in the execution prompt.

## Deployment & environments (Dokploy now → GCP later)

Two platforms consume one codebase. **Any change that affects how a service is
built, configured, or exposed must be reflected in BOTH the Dokploy and the GCP
artifacts in the same change.** Do not leave GCP as an afterthought.

### Environment model

Environments are `dev-1`, `dev-2`, `prod`, and are selected **by Git branch**.
An agent MUST derive the environment from the current branch before reading or
writing any deployment/runtime config:

| Branch | Environment (`ENV_NAME`) | `GATEWAY_PORT` | Dokploy project | Postgres DB | Cloud Build `_ENV` |
| --- | --- | --- | --- | --- | --- |
| `dev-1` | `dev-1` | `8010` | `phishguard-dev-1` | `phishguard_dev_1` | `dev-1` |
| `dev-2` | `dev-2` | `8020` | `phishguard-dev-2` | `phishguard_dev_2` | `dev-2` |
| `main` | `prod` | `8000` | `phishguard-prod` | `phishguard` | `prod` |

**If `.env` is missing (or a var is unset), do NOT guess — resolve the env from
the branch and fall back to the matching template:**

```bash
branch="$(git branch --show-current)"
case "$branch" in
  main)   ENV=prod  ;;
  dev-1*) ENV=dev-1 ;;
  dev-2*) ENV=dev-2 ;;
  *)      ENV=dev-1 ;;   # unknown/feature branch -> safest NON-prod slot
esac
# Defaults live in deploy/env/.env.$ENV.example. Never commit a real .env.
cp "deploy/env/.env.$ENV.example" .env
```

- Identity lives in **env vars only**, never in code: `ENV_NAME` +
  `COMPOSE_PROJECT_NAME` for Dokploy, `_ENV` for Cloud Build.
- `docker-compose.yml` is shared across all envs; per-env values come from
  `.env` (templates in `deploy/env/.env.<env>.example`). The Compose project
  name namespaces containers/volumes so envs can coexist on one host.
- **Only `main` maps to `prod`.** Feature branches inherit the slot of the dev
  branch they were cut from (e.g. `dev-2/login-fix` → `dev-2`). Never point a
  dev branch at prod resources, and never default an unknown branch to `prod`.
- On the Dokploy/GCP server the effective values are injected server-side
  (Dokploy stores them encrypted; Cloud Run uses `--set-env-vars`/`--set-secrets`).
  The repo templates are the source of truth when no `.env` exists locally.

### Deployment artifacts (keep in sync)

| If you change… | Also update… |
| --- | --- |
| `apps/backend/Dockerfile` or Python deps | `docker-compose.yml`, `cloudbuild.yaml`, `apps/backend/pyproject.toml` |
| `apps/extension/Dockerfile` or build inputs | `deploy/gcp/cloudbuild.extension.yaml`, `apps/extension/vite.config.ts` |
| `apps/dataset-agent/Dockerfile` or deps | `docker-compose.yml` (`dataset-agent` profile), `cloudbuild.yaml` (dataset-agent job), `deploy/env/.env.*.example` |
| Student model artifact / package layout | `STUDENT_MODEL_URL` in all env templates + `_MODEL_URL` in `cloudbuild.yaml`/`cloudbuild.extension.yaml`; don't commit new `*.onnx` candidates |
| Any new/changed env var | **all** `deploy/env/.env.*.example`, `docker-compose.yml`, `cloudbuild.yaml`, `deploy/DEPLOY_DOKPLOY.md`, `deploy/gcp/README.md` |
| A new service/container | `docker-compose.yml` **and** a Cloud Build step + Cloud Run deploy in `cloudbuild.yaml`, plus docs |
| A new secret | add it to the env templates (as `CHANGE_ME_*`) and to the `_*_SECRET` substitutions in `cloudbuild.yaml`; never commit the value |
| Wire formats (`packages/types`) | both TS and Py sides first, then any deploy env var that carries them |
| Endpoints/ports | `docker-compose.yml` healthchecks, `cloudbuild.yaml` `--port`, client URL in `apps/extension/src/background/service-worker.ts` |

### Rules

- **Never commit secrets.** `.env` is gitignored; templates use `CHANGE_ME_*`.
  On GCP, secrets come from Secret Manager via `--set-secrets`.
- **No hardcoded env/domain in code.** Inject via env (`ENV_NAME`), Dokploy
  Domains, or Cloud Run `--set-env-vars`/`--set-secrets`.
- **`prod` deploys from `main` only**, and must run with `AUTH_DEV_MODE=false`.
- **Postgres/Redis are never published** — `expose` only, internal network /
  VPC connector.
- **Single uvicorn worker** until the reputation cache moves to Redis
  (in-memory cache would diverge across workers/replicas).
- **GCP pipelines are parameterized by `_ENV`.** One trigger per branch; never
  let `prod` inherit a developer's substitutions.

### Verify deployment changes before declaring done

```bash
docker compose --env-file deploy/env/.env.dev-1.example config --quiet   # interpolation
docker build -f apps/backend/Dockerfile -t phishguard/gateway:test .       # image builds
docker build -f apps/extension/Dockerfile -t phishguard/extension:test .   # extension builds
```

- `pnpm lint` is **not** a gate (see above). Don't add it here.
- Docs: `deploy/README.md` (index), `deploy/DEPLOY_DOKPLOY.md`,
  `deploy/gcp/README.md`.

### Known deployment blockers (fix before public `prod`)

1. `services/auth.py` hardcodes `dev_mode=True`; `AUTH_DEV_MODE` is injected but
   ignored. Wire it before exposing a public domain.
2. `main.py` CORS is `allow_origins=["*"]` with credentials — narrow it.
3. `DATABASE_URL` is now consumed (SQLAlchemy async + asyncpg/aiosqlite in
   `db/database.py`), but `REDIS_URL` is unused — `services/cache.py` is still an
   in-memory dict. Migrate the reputation cache to Redis before running more than
   one uvicorn worker or replica.
4. No DuckDB anywhere; intended as in-browser DuckDB-WASM in the extension.

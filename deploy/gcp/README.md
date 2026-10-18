# GCP deployment (Cloud Run + Cloud SQL)

This is the migration target once the Dokploy setup is stable. The pipelines in
this directory are **one-per-app**, branch-driven, and environment-parameterized
so `dev-1`, `dev-2`, and `prod` never share resources.

| Pipeline | Builds | Deploys |
| --- | --- | --- |
| `cloudbuild.yaml` (repo root) | `apps/backend/Dockerfile`, `apps/dataset-agent/Dockerfile` | Cloud Run `phishguard-gateway-${_ENV}`, Cloud Run **Job** `phishguard-dataset-agent-${_ENV}` (dormant) |
| `deploy/gcp/cloudbuild.extension.yaml` | `apps/extension/Dockerfile` | Cloud Run `phishguard-extension-${_ENV}` |

`${_ENV}` accepts `dev-1`, `dev-2`, or `prod`. Every trigger passes its own
`_ENV`; nothing is inferred from the code.

---

## 1. Environment ↔ branch mapping

| Git branch | `_ENV` | Cloud Run gateway | Cloud Run extension |
| --- | --- | --- | --- |
| `dev-1` | `dev-1` | `phishguard-gateway-dev-1` | `phishguard-extension-dev-1` |
| `dev-2` | `dev-2` | `phishguard-gateway-dev-2` | `phishguard-extension-dev-2` |
| `main` | `prod` | `phishguard-gateway-prod` | `phishguard-extension-prod` |

`prod` deploys from `main` only.

---

## 2. One-time bootstrap (run once per project)

Set these shell variables first:

```bash
export PROJECT_ID=your-gcp-project
export REGION=asia-south1
export AR_REPO=phishguard
export ENV=dev-1   # repeat the per-env block for dev-2 and prod
```

Enable APIs and create the image registry (once, shared by all envs):

```bash
gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com compute.googleapis.com iam.googleapis.com

gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="PhishGuard images"
```

### Per-environment resources

```bash
# --- Cloud SQL (Postgres 16) ------------------------------------------------
gcloud sql instances create "phishguard-$ENV" \
  --database-version=POSTGRES_16 --tier=db-f1-micro \
  --region="$REGION" --storage-size=10GB

gcloud sql databases create "phishguard_$ENV" --instance="phishguard-$ENV"
gcloud sql users create phishguard \
  --instance="phishguard-$ENV" --password="$(openssl rand -base64 24)"

# --- Memorystore Redis — OPTIONAL, NOT provisioned for the MVP (in-memory cache is sufficient) ---
gcloud compute networks vpc-access connectors create "phishguard-$ENV-connector" \
  --region="$REGION" --range=10.8.0.0/28

gcloud redis instances create "phishguard-$ENV" \
  --size=1 --region="$REGION" --tier=basic \
  --redis-version=redis_7_0

# --- Runtime service account ------------------------------------------------
gcloud iam service-accounts create "phishguard-run-$ENV" \
  --display-name="PhishGuard Cloud Run $ENV"
# GRANT: roles/cloudsql.client, roles/secretmanager.secretAccessor,
#        roles/compute.networkUser (only if using the VPC connector)

# --- Secrets ----------------------------------------------------------------
printf '%s' 'postgresql+asyncpg://phishguard:PASSWORD@/phishguard_'$ENV'?host=/cloudsql/'$PROJECT_ID':'$REGION':phishguard-'$ENV \
  | gcloud secrets create "phishguard-$ENV-database-url" --data-file=-

printf '%s' 'redis://:PASSWORD@REDIS_IP:6379/0' \
  | gcloud secrets create "phishguard-$ENV-redis-url" --data-file=-

# --- Artifact Storage (Cloud Storage / RustFS) -----------------------------
gcloud storage buckets create "gs://phishguard-artifacts-$ENV" \
  --location="$REGION" --uniform-bucket-level-access
```

> Cloud Run talks to Cloud SQL over the Unix socket
> `/cloudsql/PROJECT:REGION:INSTANCE`, hence the `host=/cloudsql/...` in the
> DATABASE_URL. The backend already depends on `asyncpg` and rewrites bare `postgresql://` to `postgresql+asyncpg://`
> when the persistence work lands.

---

## 3. Cloud Build triggers

Create one trigger per branch. Replace `proj`/`substitutions` per environment.

### Gateway (backend)

```bash
gcloud builds triggers create github \
  --name="gateway-dev-1" \
  --repo-name=phishguard --repo-owner=YOUR_ORG \
  --branch-pattern='^dev-1$' \
  --build-config=cloudbuild.yaml \
  --substitutions=\
_ENV=dev-1,\
_REGION=asia-south1,\
_AR_REPO=phishguard,\
_CLOUDSQL_INSTANCE=$PROJECT_ID:asia-south1:phishguard-dev-1,\
_VPC_CONNECTOR=,\
_RUNTIME_SA=phishguard-run-dev-1@$PROJECT_ID.iam.gserviceaccount.com,\
_DB_SECRET=phishguard-dev-1-database-url,\
_MODEL_URL=https://storage.googleapis.com/<MODEL_BUCKET>/models/v2.0.0/student_model.onnx,\
_REDIS_SECRET=,\
_MIN_INSTANCES=0
```

Repeat with `^dev-2$`, and for prod (`^main$`, `_ENV=prod`, `_MIN_INSTANCES=1`,
`_BACKEND_URL=https://phishguard-gateway-prod-<PROJECT_NUMBER>.<REGION>.run.app`).

### Extension (static distribution)

```bash
gcloud builds triggers create github \
  --name="extension-dev-1" \
  --repo-name=phishguard --repo-owner=YOUR_ORG \
  --branch-pattern='^dev-1$' \
  --included-files='.dockerignore,apps/extension/**,apps/backend/models/**,packages/types/**,scripts/package_extension.py,scripts/validate_extension_model_metadata.ts,deploy/gcp/cloudbuild.extension.yaml' \
  --build-config=deploy/gcp/cloudbuild.extension.yaml \
  --substitutions=_ENV=dev-1,_REGION=asia-south1,_AR_REPO=phishguard,\
_BACKEND_URL=https://phishguard-gateway-dev-1.example.com,\
_EXTENSION_SIGNING_KEY_SECRET=phishguard-extension-signing-key-b64
```

For prod, create a second trigger with `--branch-pattern='^main$'`, `_ENV=prod`,
and `_BACKEND_URL=https://phishguard-gateway-prod-<PROJECT_NUMBER>.<REGION>.run.app`.

Cloud Build and Compose always package the current released extension. The
current 1.5.0 bundle can recover missing metadata only for the exact released
binary and does not claim student-v2 validation. A student-v2 release requires
its matching sidecar and validation reports in
`apps/backend/models/v<model-version>/`. Both Docker builds use `--local-only`,
so they do not upload extension artifacts to RustFS.

The extension build needs the CRX signing key as a Secret Manager secret
(base64 of the PEM; same key for every env so the extension ID stays
`loanjnnlfhechkonbjelmbdacmmcbagg`). Create it once from the local, untracked PEM:

```bash
base64 -w0 deploy/extension/phishguard-extension.pem | \
  gcloud secrets create phishguard-extension-signing-key-b64 --data-file=-
gcloud secrets add-iam-policy-binding phishguard-extension-signing-key-b64 \
  --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

`_BACKEND_URL` is the public `https://` origin of the backend gateway service.
It configures all frontend backend access: download, update, escalate, and health probes.
When empty it defaults to the derived Cloud Run URL of `phishguard-gateway-${_ENV}`
(`https://phishguard-gateway-${_ENV}-${PROJECT_NUMBER}.${_REGION}.run.app`).
The pipeline builds with `DOCKER_BUILDKIT=1` and `--secret id=EXTENSION_SIGNING_KEY_B64,env=...`, which needs
BuildKit support in `gcr.io/cloud-builders/docker` (Docker 23+).

---

## 4. Manual runs

```bash
# Gateway
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_ENV=dev-1,_REGION=asia-south1

# Extension
gcloud builds submit --config deploy/gcp/cloudbuild.extension.yaml \
  --substitutions=_ENV=prod,_REGION=asia-south1,\
_BACKEND_URL=https://phishguard-gateway-prod-<PROJECT_NUMBER>.<REGION>.run.app

# Check what was deployed
gcloud run services describe phishguard-gateway-dev-1 --region=asia-south1 \
  --format='value(status.url)'
```

### Dataset agent job

`cloudbuild.yaml` also builds `apps/dataset-agent/Dockerfile` and deploys the
**Cloud Run Job** `phishguard-dataset-agent-${_ENV}`. It is intentionally
**dormant**: the pipeline never passes `--execute-now` and no Cloud Scheduler
trigger is created.

```bash
# Optional one-time setup -----------------------------------------------
# Gemini key for the Deep Research stage (enable via _DATASET_AGENT_DEEP_RESEARCH=true)
printf '%s' 'YOUR_GEMINI_API_KEY' \
  | gcloud secrets create "phishguard-$ENV-gemini-api-key" --data-file=-
gcloud secrets add-iam-policy-binding "phishguard-$ENV-gemini-api-key" \
  --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

# Persistent output bucket (optional; without it, output is ephemeral)
gcloud storage buckets create "gs://phishguard-datasets-$ENV" \
  --location="$REGION" --uniform-bucket-level-access
```

Wire them via trigger substitutions: `_GEMINI_SECRET=phishguard-$ENV-gemini-api-key`,
`_DATASET_BUCKET=phishguard-datasets-$ENV`,
`_DATASET_AGENT_DEEP_RESEARCH=true|false`.

`_GEMINI_SECRET` is also mounted on the gateway as `GEMINI_API_KEY` and enables the
Gemini ADK cloud teacher behind `POST /v1/escalate`, `POST /v1/escalate/gemini` and the playground
(`/v1/escalate` falls back to deterministic evidence-v2 when unconfigured or degraded; the opt-in consented
screenshot is forwarded to the Gemini API). Model via `_GEMINI_TEACHER_MODEL`
(default `gemini-3.5-flash-lite`); global hourly cap via `_GEMINI_TEACHER_MAX_CALLS`
(default `200`, becomes `GEMINI_TEACHER_MAX_CALLS_PER_HOUR`).

The gateway runtime service account needs
`roles/secretmanager.secretAccessor` on that secret:

```bash
gcloud secrets add-iam-policy-binding "phishguard-$ENV-gemini-api-key" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor
```

Without `_GEMINI_SECRET` the gateway keeps the `cloud-evidence-v2` heuristics.

```bash
# Execute the job manually (the only way it runs today)
gcloud run jobs execute phishguard-dataset-agent-dev-1 --region=asia-south1
```

To schedule it later, create a Cloud Scheduler job that calls
`run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/phishguard-dataset-agent-${_ENV}:run`
with an OAuth token — documented here only; do not create it until the daily
cycle is proven.


---

## 5. Notes & gotchas

- **Extension signing key (gateway build):** the gateway image build packages the extension, so the
  `build-gateway` step uses BuildKit with `--secret id=EXTENSION_SIGNING_KEY_B64` from Secret Manager
  (`_EXTENSION_SIGNING_KEY_SECRET`, default `phishguard-extension-signing-key-b64`) and the build arg
  `_BACKEND_URL`. Grant the Cloud Build service account
  `roles/secretmanager.secretAccessor` on that secret (same secret as the extension pipeline).
- **Vision:** the gateway loads MobileNetV3-Small (weights pre-baked into the
  image under `TORCH_HOME=/app/.cache/torch`) to compare consented screenshots
  with the brand gallery in `apps/backend/assets/brand_gallery/`. Cloud Run
  runs with `_MEMORY=2Gi` (`--memory`). Screenshots are scored in memory and
  never stored or logged by the gateway (forwarded to the Gemini API when the teacher is configured).
- **Cold starts:** the gateway builds a small torch model at import time. Keep
  `_MIN_INSTANCES=1` for `prod` to avoid a multi-second first request.
- **`--allow-unauthenticated`** is set because a Chrome extension must reach the
  API without IAM. Application-level bearer auth is the real gate — and it is
  currently a **POC stub** (see `deploy/DEPLOY_DOKPLOY.md` §6). Fix auth before
  exposing `prod`.
- **Cloud Build must be allowed to deploy:** grant the Cloud Build service
  account `roles/run.admin`, `roles/iam.serviceAccountUser`, and
  `roles/artifactregistry.writer`.
- **Torch layer is rebuilt every run** (~200 MB download). If build time becomes
  painful, add `--cache-from` against the `${_ENV}-latest` tag or use a
  persistent dependency image.
- **One `_ENV` per trigger.** Never let `prod` inherit a developer's
  substitutions — that is the entire point of the parameterization.
- **Gemini teacher budget:** `GEMINI_TEACHER_MAX_CALLS_PER_HOUR` (via `_GEMINI_TEACHER_MAX_CALLS`) is a global
  in-memory cap, and per-IP rate limits (playground 12/min, `/v1/escalate/gemini` 20/min) are in-memory too, so
  they assume a single gateway instance (`--max-instances=1`) until a shared store exists.


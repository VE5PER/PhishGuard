# Deploying PhishGuard

Two platforms, one codebase, three environments.

## Environments

| Environment | Git branch | Dokploy project | Cloud Run service (`_ENV`) |
| --- | --- | --- | --- |
| dev-1 | `dev-1` | `phishguard-dev-1` | `phishguard-gateway-dev-1` |
| dev-2 | `dev-2` | `phishguard-dev-2` | `phishguard-gateway-dev-2` |
| prod | `main` | `phishguard-prod` | `phishguard-gateway-prod` |

Environment identity lives entirely in **env vars**, never in the code:
`ENV_NAME` + `COMPOSE_PROJECT_NAME` for Dokploy, `_ENV` for Cloud Build. The
compose project name namespaces containers, volumes, and ports, so both developers can
run on the same host without collisions.

Artifact storage is managed via **RustFS**, providing S3-compatible
high-performance storage for versioned ONNX model binaries, extension distribution packages,
and forensic payloads (hosted externally and reached via `RUSTFS_ENDPOINT_URL`).

## Guides

| Topic | Document |
| --- | --- |
| Current Dokploy deployment (gateway + datastores) | [`DEPLOY_DOKPLOY.md`](./DEPLOY_DOKPLOY.md) |
| GCP migration: Cloud Run, Cloud SQL, Memorystore, Cloud Storage / RustFS, Cloud Build | [`gcp/README.md`](./gcp/README.md) |

## Env templates

```text
deploy/env/.env.dev-1.example
deploy/env/.env.dev-2.example
deploy/env/.env.prod.example
```

Copy the matching one to `.env` (Dokploy: paste into the service Environment
editor) and replace every `CHANGE_ME_*`. `.env` is gitignored.

## Pipelines

```text
cloudbuild.yaml                          # backend -> Cloud Run
deploy/gcp/cloudbuild.extension.yaml     # extension -> Cloud Run (static)
```

Both are parameterized by `_ENV`; see the GCP guide for trigger setup.

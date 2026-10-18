# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# PhishGuard FastAPI Escalation Gateway
#
# Build context MUST be the repository root. The frontend-builder stage packages the
# browser extension (signed CRX + zips served by the gateway), so the CRX signing key is a
# BuildKit secret (base64 of the PEM) and is never stored in git or the image. Generate or
# reuse the key with scripts/bootstrap.sh / scripts/extension_key.py, then:
#   EXTENSION_SIGNING_KEY_B64="$(base64 -w0 deploy/extension/phishguard-extension.pem)" \
#   docker build -f apps/backend/Dockerfile \
#     --secret id=EXTENSION_SIGNING_KEY_B64,env=EXTENSION_SIGNING_KEY_B64 \
#     --build-arg BACKEND_URL=https://<gateway-domain> \
#     -t phishguard/gateway .
# docker compose / Cloud Build / Dokploy pass the same secret and build arg.
# ---------------------------------------------------------------------------

# --- Stage 1: Build landing page static assets and extension package -------
FROM node:20-alpine AS frontend-builder
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PHISHGUARD_SKIP_VERSION_BUMP=1
RUN apk add --no-cache zip curl python3 py3-cryptography
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Manifests first so dependency install is cached independently of source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY version.json ./version.json
COPY packages/types/package.json packages/types/
COPY apps/landing/package.json apps/landing/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile

COPY packages/types packages/types
COPY apps/landing apps/landing
COPY apps/extension apps/extension
COPY apps/backend/models apps/backend/models
COPY scripts scripts
COPY deploy/extension deploy/extension

ARG BACKEND_URL
ARG GATEWAY_DOMAIN
ARG EXTENSION_UPDATE_BASE_URL
ARG STUDENT_MODEL_URL=""

# The INT8 student model binary is gitignored (see .dockerignore negations).
# Fetch it when it is not supplied in the build context; package_extension.py
# validates its SHA-256 against the committed metadata before packaging.
RUN if [ ! -f apps/extension/public/models/student_model.onnx ]; then \
      test -n "${STUDENT_MODEL_URL}" || { \
        echo "ERROR: apps/extension/public/models/student_model.onnx is absent and STUDENT_MODEL_URL is unset."; \
        echo "Provide the v2.0.0 release model (RustFS/GCS URL) via --build-arg STUDENT_MODEL_URL=..."; \
        exit 1; \
      }; \
      echo "Fetching student model from ${STUDENT_MODEL_URL}"; \
      mkdir -p apps/extension/public/models; \
      curl -fsSL "${STUDENT_MODEL_URL}" -o apps/extension/public/models/student_model.onnx; \
    fi

RUN --mount=type=secret,id=EXTENSION_SIGNING_KEY_B64,required=true \
    EFFECTIVE_BACKEND_URL="${BACKEND_URL:-${GATEWAY_DOMAIN:-${EXTENSION_UPDATE_BASE_URL:-}}}" \
 && pnpm --filter @phishguard/types build \
 && pnpm --filter @phishguard/landing build \
 && BACKEND_URL="${EFFECTIVE_BACKEND_URL}" pnpm --filter @phishguard/extension build \
 && EXTENSION_SIGNING_KEY_FILE=/run/secrets/EXTENSION_SIGNING_KEY_B64 \
    BACKEND_URL="${EFFECTIVE_BACKEND_URL}" \
    python3 scripts/package_extension.py --local-only --require-backend-url

# --- Stage 2: Runtime Python Gateway ---------------------------------------
FROM python:3.12-slim AS runtime

# Copy uv binary from official Astral image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_NO_CACHE=1 \
    PYTHONHASHSEED=0 \
    STATIC_DIR=/app/apps/backend/static \
    TORCH_HOME=/app/.cache/torch

# libgomp1 is required by torch's OpenMP runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- 1. CPU-only torch + torchvision (biggest layer, kept early for cache reuse)
RUN uv pip install --system --index-url https://download.pytorch.org/whl/cpu "torch>=2.2,<3" "torchvision>=0.17,<1"

# Pre-download the MobileNetV3-Small weights used by the vision check, into
# TORCH_HOME under /app so the chown below hands them to appuser.
RUN python -c "from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights as W; mobilenet_v3_small(weights=W.IMAGENET1K_V1)"

# --- 2. Real runtime deps + build tooling for local packages ----------------
# Includes the backend's DB drivers (declared in apps/backend/pyproject.toml).
RUN uv pip install --system "fastapi>=0.100.0" "uvicorn>=0.23.0" "pydantic>=2.0.0" numpy pillow \
      "sqlalchemy>=2.0.0" "asyncpg>=0.29.0" "aiosqlite>=0.19.0" "greenlet>=3.0.0" "httpx>=0.25.0" \
      "google-adk==2.11.0" "google-genai>=2.28.0,<3" \
      setuptools wheel

# --- 3. Install the workspace packages --------------------------------------
COPY packages/types /app/packages/types
COPY packages/ml-engine /app/packages/ml-engine
COPY apps/backend /app/apps/backend

# Copy built landing page and extension downloads into static directory
COPY --from=frontend-builder /repo/apps/landing/out /app/apps/backend/static
COPY --from=frontend-builder /repo/apps/backend/static/downloads /app/apps/backend/static/downloads

RUN uv pip install --system --no-deps --no-build-isolation \
      -e ./packages/types -e ./packages/ml-engine -e ./apps/backend

# --- 4. Run as non-root, with a writable STATIC_DIR -------------------------
# main.py runs `STATIC_DIR.mkdir(...)` at import time. STATIC_DIR is derived
# from the installed package location, so create it here while still root.
RUN useradd --create-home --uid 10001 appuser \
 && chown -R appuser:appuser /app \
 && STATIC_DIR="$(python -c 'import phishguard_backend, pathlib; print(pathlib.Path(phishguard_backend.__file__).resolve().parent.parent.parent / "static")')" \
 && mkdir -p "$STATIC_DIR/downloads" \
 && chown -R appuser:appuser "$STATIC_DIR" \
 && echo "STATIC_DIR=$STATIC_DIR"
USER appuser

# Default port; overridden at runtime via $PORT (Compose sets PORT=GATEWAY_PORT,
# Cloud Run injects PORT=8080).
EXPOSE 8000

# NOTE: single worker on purpose — ReputationCacheService is in-memory today,
# so multiple uvicorn workers would give divergent caches. Add workers only
# after the cache is moved to Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/health', timeout=3)"

CMD ["sh", "-c", "exec uvicorn phishguard_backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

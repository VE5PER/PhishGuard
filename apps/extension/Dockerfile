# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# PhishGuard Browser Extension — build + distribution app
#
# This is NOT a runtime service. It is a Dokploy Application whose only job is
# to (re)build the Manifest V3 bundle from source and serve a downloadable,
# load-unpacked zip at a stable URL. Deploy it as a SECOND app alongside the
# gateway compose stack.
#
# Build context MUST be the repository root. The CRX signing key is a BuildKit
# secret (base64 of the PEM) and is never stored in git or the image:
#   EXTENSION_SIGNING_KEY_B64="$(base64 -w0 deploy/extension/phishguard-extension.pem)" \
#   docker build -f apps/extension/Dockerfile \
#     --secret id=EXTENSION_SIGNING_KEY_B64,env=EXTENSION_SIGNING_KEY_B64 \
#     --build-arg BACKEND_URL=https://<gateway-domain> \
#     -t phishguard/extension-dist .
#
# The single BACKEND_URL env var configures download, update, escalate, and health probes.
# The packaged manifest gets update_url = <BACKEND_URL>/download/updates.xml.
# Chrome auto-updates CRX installs from that URL (enterprise policy on Windows/macOS):
#   <extension-id>;https://<gateway-domain>/download/updates.xml
# ---------------------------------------------------------------------------

# ---- Stage 1: build the workspace -----------------------------------------
FROM node:20-alpine AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PHISHGUARD_SKIP_VERSION_BUMP=1
RUN apk add --no-cache zip curl python3 py3-cryptography
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Manifests first so dependency install is cached independently of source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY version.json ./version.json
COPY packages/types/package.json packages/types/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/types packages/types
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

# Build types, extension, and full distribution packages (ZIP, Web Store ZIP, CRX, updates.xml, metadata)
RUN --mount=type=secret,id=EXTENSION_SIGNING_KEY_B64,required=true \
    EFFECTIVE_BACKEND_URL="${BACKEND_URL:-${GATEWAY_DOMAIN:-${EXTENSION_UPDATE_BASE_URL:-}}}" \
 && pnpm --filter @phishguard/types build \
 && BACKEND_URL="${EFFECTIVE_BACKEND_URL}" pnpm --filter @phishguard/extension build \
 && EXTENSION_SIGNING_KEY_FILE=/run/secrets/EXTENSION_SIGNING_KEY_B64 \
    BACKEND_URL="${EFFECTIVE_BACKEND_URL}" \
    python3 scripts/package_extension.py --local-only --require-backend-url

# ---- Stage 2: static distribution host ------------------------------------
FROM nginx:1.29-alpine AS dist

WORKDIR /usr/share/nginx/html
# Preserve the layout Chrome expects: manifest.json at the zip root.
COPY apps/extension/manifest.json ./manifest.json
COPY apps/extension/popup/popup.html ./popup/popup.html
COPY apps/extension/options/options.html ./options/options.html
COPY apps/extension/public/icons ./icons
COPY --from=build /repo/apps/extension/dist ./dist
COPY --from=build /repo/apps/backend/static/downloads ./download
COPY deploy/extension/index.html ./index.html

EXPOSE 80

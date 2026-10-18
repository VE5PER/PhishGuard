#!/usr/bin/env bash
# One-command local setup for PhishGuard: prerequisite checks, .env, Node + Python dependencies and the
# extension signing key. Idempotent: safe to re-run; never overwrites an existing .env or signing key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GENERATE_KEY=0
SKIP_NODE=0
SKIP_PYTHON=0
SKIP_ENV=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

Sets up a development machine: checks prerequisites, creates .env from the branch template, installs
Node and Python dependencies, and prepares the extension signing key for builds.

Options:
  --generate-key   generate a NEW signing key if none exists (CHANGES the extension ID and breaks
                   updates for existing installs; the default is to reuse the existing key)
  --skip-node      skip `pnpm install`
  --skip-python    skip the Python virtualenv and package installs
  --skip-env       skip creating .env from deploy/env/.env.<env>.example
  -h, --help       show this help

The existing key lives at deploy/extension/phishguard-extension.pem (untracked). Get it from the team
secret store. Inspect it any time with: .venv/bin/python scripts/extension_key.py status
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --generate-key) GENERATE_KEY=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-env) SKIP_ENV=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

MISSING=0
ok() { printf '  \342\234\223 %s\n' "$1"; }
fail() { printf '  \342\234\227 %s\n      hint: %s\n' "$1" "$2"; MISSING=1; }
optional() { printf '  - %s (optional)\n' "$1"; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

check_prerequisites() {
  echo "Checking prerequisites"

  if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"
  else fail "git not found" "install git from your package manager"; fi

  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node --version | sed 's/^v//')"
    if version_ge "$node_version" "20.0.0"; then ok "node $node_version"
    else fail "node $node_version (need >= 20)" "install Node 20+ (https://nodejs.org or nvm install 20)"; fi
  else fail "node not found" "install Node 20+ (https://nodejs.org or nvm install 20)"; fi

  if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm --version)"
  else fail "pnpm not found" "corepack enable && corepack prepare pnpm@9 --activate"; fi

  if command -v python3 >/dev/null 2>&1; then
    local py_version
    py_version="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
    if version_ge "$py_version" "3.12.0"; then ok "python3 $py_version"
    else fail "python3 $py_version (need >= 3.12)" "install Python 3.12+ (uv can fetch it: uv python install 3.12)"; fi
  else fail "python3 not found" "install Python 3.12+ (uv python install 3.12)"; fi

  if command -v uv >/dev/null 2>&1; then ok "uv $(uv --version | awk '{print $2}')"
  else fail "uv not found" "curl -LsSf https://astral.sh/uv/install.sh | sh"; fi

  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then ok "docker compose $(docker compose version --short 2>/dev/null || echo v2)"
    else fail "docker compose v2 not available" "install the Docker Compose v2 plugin (https://docs.docker.com/compose/install/)"; fi
    if docker buildx version >/dev/null 2>&1; then ok "docker buildx (BuildKit secrets supported)"
    else fail "docker buildx not available" "install the buildx plugin; build secrets for the extension key require BuildKit"; fi
  else
    fail "docker not found" "install Docker Engine/Desktop with Compose v2 and buildx"
  fi

  if command -v base64 >/dev/null 2>&1; then ok "base64"
  else optional "base64 not found (only needed for manual key export; scripts/extension_key.py export-env does not need it)"; fi

  if [ "$MISSING" -ne 0 ]; then
    echo
    echo "Missing required tools. Install them and re-run scripts/bootstrap.sh." >&2
    exit 1
  fi
}

resolve_env_name() {
  local branch
  branch="$(git branch --show-current 2>/dev/null || true)"
  case "$branch" in
    main)   echo "prod" ;;
    dev-1*) echo "dev-1" ;;
    dev-2*) echo "dev-2" ;;
    *)      echo "dev-1" ;;
  esac
}

setup_env_file() {
  echo
  echo "Environment file"
  local env_name template
  env_name="$(resolve_env_name)"
  template="deploy/env/.env.${env_name}.example"
  if [ -f .env ]; then
    ok ".env already exists (left untouched)"
  elif [ -f "$template" ]; then
    cp "$template" .env
    chmod 600 .env
    ok "created .env from $template (ENV=$env_name); review the CHANGE_ME_* values"
  else
    fail "template $template not found" "restore deploy/env/ from git"
    exit 1
  fi
}

install_node() {
  echo
  echo "Node dependencies"
  pnpm install
  ok "pnpm install done"
}

install_python() {
  echo
  echo "Python environment"
  if [ ! -x .venv/bin/python ]; then
    uv venv --python 3.12 .venv
    ok "created .venv (Python 3.12)"
  else
    ok ".venv already exists"
  fi

  uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cpu \
    "torch>=2.2,<3" "torchvision>=0.17,<1"
  ok "installed CPU torch + torchvision"

  uv pip install --python .venv/bin/python \
    -e packages/types -e packages/ml-engine -e apps/backend -e apps/ml-lifecycle -e apps/dataset-agent \
    pytest cryptography
  ok "installed workspace packages, pytest and cryptography"
}

setup_signing_key() {
  echo
  echo "Extension signing key"
  local py=".venv/bin/python"
  if [ ! -x "$py" ]; then
    fail "no .venv available to run scripts/extension_key.py" "re-run without --skip-python"
    exit 1
  fi

  local status=0
  "$py" scripts/extension_key.py status || status=$?

  case "$status" in
    0)
      if [ "$SKIP_ENV" -eq 1 ]; then
        ok "key matches the manifest (skipping .env export)"
      else
        "$py" scripts/extension_key.py export-env --env-file .env
        ok "EXTENSION_SIGNING_KEY_B64 written to .env"
      fi
      ;;
    1)
      echo "The signing key does NOT match apps/extension/manifest.json. Packaging would fail." >&2
      echo "Use the key that belongs to this manifest, or accept a new extension ID with:" >&2
      echo "  $py scripts/extension_key.py generate --force" >&2
      exit 1
      ;;
    2)
      if [ "$GENERATE_KEY" -eq 1 ]; then
        echo "No key found: generating a NEW one (this changes the extension ID)."
        "$py" scripts/extension_key.py generate
        if [ "$SKIP_ENV" -eq 0 ]; then
          "$py" scripts/extension_key.py export-env --env-file .env
        fi
      else
        cat >&2 <<'EOF'

No extension signing key found. Either:
  1. Get the existing phishguard-extension.pem from the team secret store and place it at
       deploy/extension/phishguard-extension.pem
     then re-run scripts/bootstrap.sh (keeps the extension ID loanjnnlfhechkonbjelmbdacmmcbagg), or
  2. Re-run with --generate-key to create a NEW key. WARNING: this changes the extension ID and
     existing installs will stop receiving updates.
EOF
        exit 1
      fi
      ;;
    *)
      echo "extension_key.py status exited with $status" >&2
      exit 1
      ;;
  esac
}

print_next_steps() {
  cat <<'EOF'

Setup complete. Next:
  docker compose -f docker-compose.local.yml up -d --build   # gateway + datastores
  pnpm --filter @phishguard/landing dev                       # landing page dev server
  pnpm test                                                   # TypeScript tests
  .venv/bin/python -m pytest packages/types apps/backend      # Python tests
EOF
}

check_prerequisites
[ "$SKIP_ENV" -eq 0 ] && setup_env_file
[ "$SKIP_NODE" -eq 0 ] && install_node
[ "$SKIP_PYTHON" -eq 0 ] && install_python
setup_signing_key
print_next_steps

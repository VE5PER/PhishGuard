#!/usr/bin/env bash
# ==============================================================================
# PhishGuard Chrome DevTools & Extension Debug Launcher
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXT_DIR="${REPO_ROOT}/apps/extension"
DEBUG_PORT="${CHROME_DEBUG_PORT:-9222}"
DEBUG_PROFILE="/tmp/phishguard-chrome-dev"

echo "========================================================"
echo "🛡️  PhishGuard Chrome Extension Debug Launcher"
echo "========================================================"
echo "Repository Root : ${REPO_ROOT}"
echo "Extension Path  : ${EXT_DIR}"
echo "Debugging Port  : ${DEBUG_PORT}"
echo "Debug Profile   : ${DEBUG_PROFILE}"
echo "========================================================"

# Find Chrome / Chromium executable
CHROME_BIN=""
for candidate in \
    "/opt/google/chrome/chrome" \
    "google-chrome" \
    "google-chrome-stable" \
    "chromium" \
    "chromium-browser" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if command -v "${candidate}" >/dev/null 2>&1; then
        CHROME_BIN="$(command -v "${candidate}")"
        break
    elif [ -x "${candidate}" ]; then
        CHROME_BIN="${candidate}"
        break
    fi
done

if [ -z "${CHROME_BIN}" ]; then
    echo "❌ Error: Google Chrome or Chromium executable not found on PATH." >&2
    exit 1
fi

echo "Using Browser: ${CHROME_BIN}"

# Build extension if needed
if [ ! -d "${EXT_DIR}/dist" ] || [ ! -f "${EXT_DIR}/dist/background.js" ]; then
    echo "📦 Building extension bundle..."
    (cd "${REPO_ROOT}" && pnpm --filter @phishguard/extension build)
fi

echo ""
echo "🚀 Launching Chrome with remote debugging on port ${DEBUG_PORT}..."
echo "To connect Chrome DevTools MCP:"
echo "  npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:${DEBUG_PORT}"
echo ""

exec "${CHROME_BIN}" \
    --remote-debugging-port="${DEBUG_PORT}" \
    --user-data-dir="${DEBUG_PROFILE}" \
    --load-extension="${EXT_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    "$@"

# PhishGuard: Development & Operations Guide

This guide holds the developer and operator detail. For the product overview, start with the [README](../README.md).
Architecture rules and agent directives live in [`AGENTS.md`](../AGENTS.md); deployment is covered in
[`deploy/DEPLOY_DOKPLOY.md`](../deploy/DEPLOY_DOKPLOY.md) and [`deploy/gcp/README.md`](../deploy/gcp/README.md).

Commands below use Linux/macOS paths (`.venv/bin/...`). On Windows, use `.\.venv\Scripts\...` instead
(for example `.\.venv\Scripts\python.exe`).

---

## Prerequisites

| Tool | Version | Notes |
| :--- | :--- | :--- |
| **git** | any recent | branch name selects the environment (`main` → prod, `dev-1*`, `dev-2*`) |
| **Node.js** | 20+ | `corepack enable && corepack prepare pnpm@9 --activate` |
| **pnpm** | 9+ | workspace package manager |
| **Python** | 3.12+ | managed with `uv` |
| **uv** | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **Docker** | Compose v2 + buildx | BuildKit is required: the extension signing key is a build secret |

### One-command setup

```bash
./scripts/bootstrap.sh
```

The script checks the tools above (✓/✗ with install hints), creates `.env` from `deploy/env/.env.<env>.example` if it
does not exist (never overwrites it), runs `pnpm install`, builds `.venv` with CPU `torch`/`torchvision` and the
editable workspace packages, and prepares the extension signing key (below). It is idempotent. Flags:
`--generate-key` (create a **new** key if none exists), `--skip-node`, `--skip-python`, `--skip-env`, `-h`.

---

## Extension signing key

The extension is packaged as a signed `.crx` with a persistent RSA key. That key fixes the extension ID
(`loanjnnlfhechkonbjelmbdacmmcbagg`; its public half is the `key` in `apps/extension/manifest.json`), and Chrome only
auto-updates installs whose ID stays the same. **Never change the key casually: a new key means a new ID and every
existing install stops receiving updates.**

- **Where it lives locally:** `deploy/extension/phishguard-extension.pem` (untracked, never baked into images). Get the
  existing file from the team secret store.
- **Helper:** `scripts/extension_key.py`
  - `status` (default): shows where the key was found, the derived and manifest IDs, and `MATCH`/`MISMATCH`
    (exit 0/1, or 2 when there is no key).
  - `generate [--force] [--no-update-manifest]`: creates a **new** RSA-2048 key (mode 0600), rewrites the manifest `key`
    and lists the files that still mention the old ID. Refuses to overwrite an existing key without `--force`.
  - `export-env [--env-file PATH] [--print]`: upserts `EXTENSION_SIGNING_KEY_B64` (base64 of the PEM) into `.env`;
    `--print` writes the value to stdout for CI secret managers. The private key is never printed otherwise.
- **How builds receive it:** the gateway and extension Docker builds both read the build secret
  `EXTENSION_SIGNING_KEY_B64` (never an image layer) plus the build arg `BACKEND_URL`.
  - Local compose: `pnpm compose:local` bumps the extension patch version, then runs
    `docker compose -f docker-compose.local.yml up -d --build`, which reads it from `.env`/your shell.
    Running `docker compose` directly packages the current version without bumping it.
    The gateway packages the already released 1.5.0 model; missing legacy metadata is recovered only for its exact binary, without claiming student-v2 validation.
  - Dokploy: add it under **Build-time Secrets** (see `deploy/DEPLOY_DOKPLOY.md`).
  - Cloud Build: Secret Manager secret `phishguard-extension-signing-key-b64`, exposed with `availableSecrets`
    (see `deploy/gcp/README.md`).
- **Rotation:** a new key means a new extension ID, and Chrome cannot migrate existing installs to it. Treat rotation
  as a deliberate migration: users install the new extension, and the manifest `key` plus every `update_url` or policy
  entry that references the old ID must change together.
- **Security note:** the PEM was committed once and still appears in git history (commit `dbefdb5`). Treat it as
  exposed and schedule a deliberate rotation before a public production release. Never commit it again.

---

## Running the stack

### Option 1: Local Docker Compose (everything)

```bash
pnpm compose:local          # bump version, build and start gateway, Postgres, Redis, RustFS, dataset agent
pnpm compose:local:logs     # follow gateway logs
pnpm compose:local:down     # stop
```

The gateway serves the landing page, `/playground`, the sandbox pages and the API at `http://localhost:8010`
(`GATEWAY_PORT`, default `8010`). Set `GEMINI_API_KEY` in `.env` to enable the Gemini ADK teacher; without it the
gateway answers with the deterministic evidence-v2 policy.

### Option 2: Bare Python (gateway only)

#### 1. Install dependencies

```bash
# Install Node.js workspace dependencies
pnpm install

# Create the Python virtual environment
uv venv --python 3.12 .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\activate

# Install Python packages in editable mode
uv pip install -e packages/types -e packages/ml-engine -e apps/backend
```

#### 2. Start the Cloud Escalation Gateway

```bash
.venv/bin/uvicorn phishguard_backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Interactive API documentation is available at: `http://localhost:8000/docs`

---

## Artifact storage (RustFS)

PhishGuard utilizes an embedded/managed **RustFS** distributed object store hosted at `http://rustfs:9000/` (with a management console at port `9001`):

- **S3 API Compatibility:** Standard S3 REST endpoints with AWS SigV4 cryptographic signature authorization.
- **Versioned Model Distribution:** Stores edge-distilled ONNX student model checkpoints (streamed with dynamic SHA-256 and ETag verification at `/v1/models/{version}/download`).
- **Extension Packages:** Stores signed Chromium packages (`.crx`), Web Store submission archives (`.zip`), Chromium autoupdate manifests (`updates.xml`), and release metadata (`extension-meta.json`), served at `/download/*`.
- **Arbitrary Artifact Streaming:** Custom artifacts can be fetched directly via `/v1/artifacts/{artifact_path}`.
- **Graceful Fallback:** If RustFS is unreachable or bootstrapping, the gateway automatically falls back to local on-disk assets without interrupting user downloads.

---

## Load & distribute the browser extension

The UI distributes the extension as a `.zip` that users load unpacked. The packager still builds a signed `.crx`
(served at `/download/phishguard-extension.crx`) for Chromium auto-update and policy installs, but no page links to it.

### Option A: Install the released `.zip`

1. **Download the Package:**
   Download `phishguard-extension.zip` from the running gateway:
   - **Web Landing Page:** Visit the gateway root (`http://localhost:8010/` with compose, `http://localhost:8000/` with bare uvicorn) and click **Add to Chrome** &rarr; **Download .zip**
   - **Direct Endpoint:** `/download/phishguard-extension.zip` (or `/download/extension`)
   - **Or Build Locally:** Run `pnpm package:extension`
2. **Unzip** it into a folder you'll keep.
3. **Open Extensions Manager:**
   Navigate to `chrome://extensions/` in Chrome, Brave, or Edge, and switch **Developer mode** on.
4. **Load Unpacked:**
   Click **Load unpacked** and select the unzipped folder. The manifest `key` keeps the deterministic ID `loanjnnlfhechkonbjelmbdacmmcbagg`.

### Option B: Load unpacked from source (development & source auditing)

1. Build the extension bundle:
   ```bash
   pnpm --filter @phishguard/extension build
   ```
2. Navigate to `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the directory: `apps/extension` (or extract `phishguard-extension.zip`).
4. Interact with any website: pointer kinematics and DOM events will be passively analyzed in real time. Click the PhishGuard toolbar icon to inspect live threat metrics.

### Extension packaging & distribution status

| Distribution Channel | Artifact | Status | Details |
| :--- | :--- | :---: | :--- |
| **Direct CRX Drag & Drop** | `phishguard-extension.crx` | **ACTIVE** | Pure-Python CRX3 engine (zero browser dependency), signed with RSA-2048 key. |
| **Web Store / Unpacked ZIP** | `phishguard-extension.zip` | **ACTIVE** | Clean store-ready archive with bundled student model and deterministic key. |
| **Chromium Autoupdate** | `updates.xml` | **ACTIVE** | Chromium protocol 2.0 manifest served at `/updates.xml`. |
| **Extension Metadata API** | `extension-meta.json` | **ACTIVE** | Dynamic SHA-256 digests and version details served at `/v1/extension/latest`. |
| **Fixed Extension ID** | `loanjnnlfhechkonbjelmbdacmmcbagg` | **LOCKED** | Base64 DER RSA public key embedded in `apps/extension/manifest.json`. |

The on-device INT8 model (`student_model.onnx`) is gitignored and distributed out-of-band. Builds fetch it through the
`STUDENT_MODEL_URL` build arg, and `scripts/package_extension.py` refuses to package a missing or mismatched model.

---

## Debug the extension with Chrome DevTools MCP

PhishGuard integrates with the official [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`chrome-devtools-mcp`), allowing AI agents (Antigravity, Claude, Cursor) to inspect the running browser, observe service worker console logs, monitor escalation network requests, and profile on-device ONNX inference:

1. **Enable Remote Debugging in Chrome:**
   - **Dynamic (Chrome 144+):** Navigate to `chrome://inspect/#remote-debugging` and enable the **Remote debugging** toggle.
   - **Dedicated Debug Session:** Run `pnpm chrome:debug` (or `google-chrome --remote-debugging-port=9222 --load-extension=apps/extension`).
2. **Configure MCP Server:**
   Add to `~/.gemini/config/mcp_config.json` (or `.cursor/mcp.json` / Claude config):
   ```json
   {
     "mcpServers": {
       "chrome-devtools": {
         "command": "npx",
         "args": ["-y", "chrome-devtools-mcp@latest", "--auto-connect"]
       }
     }
   }
   ```
3. **Run or Test Connection:**
   ```bash
   # Connect directly via port 9222
   pnpm mcp:devtools
   ```
4. **Key Inspection Capabilities:**
   - `list_pages` & `select_page`: Switch between target web tabs, background worker, and popup inspector.
   - `list_console_messages`: Read telemetry sampling logs, risk calculations, and student model output.
   - `list_network_requests`: Inspect escalation payloads sent to `POST /v1/escalate`.
   - `take_heapsnapshot`: Verify memory usage against the **~200 MiB soft target / 512 MiB hard ceiling** RAM constraint.

See [`apps/extension/README.md`](../apps/extension/README.md) for detailed recipes, profiling procedures, and API references.

---

## Train & export the on-device student model

```bash
# Run synthetic Bézier distillation benchmark
.venv/bin/python -c "from phishguard_ml_engine.training.train_student import run_synthetic_training_benchmark; res = run_synthetic_training_benchmark(epochs=3); print(res)"

# Export INT8 ONNX student model to the extension
.venv/bin/python -c "from phishguard_ml_engine.export.export_onnx import export_student_to_onnx; export_student_to_onnx(output_path='apps/extension/public/models/student_model.onnx')"
```

The full training lifecycle (checkpoints, validation gates, ONNX compilation, release promotion) lives in
[`apps/ml-lifecycle`](../apps/ml-lifecycle); the daily dataset agent lives in [`apps/dataset-agent`](../apps/dataset-agent).

---

## Automated testing & verification

```bash
# 1. Python unit and integration tests
.venv/bin/python -m pytest packages/types packages/ml-engine apps/backend apps/ml-lifecycle apps/dataset-agent -v

# 2. TypeScript schema and on-device engine tests (build @phishguard/types first; consumers import its dist/)
pnpm test

# 3. Strict TypeScript type-checking
pnpm typecheck

# 4. Extension production bundle
pnpm build

# 5. Packaging contract tests (no torch; validates Dockerfile/version/packaging rules)
.venv/bin/python -m pytest scripts/tests -v
```

`pnpm build` runs `scripts/bump-version.mjs`, which rewrites the version in several files. Set
`PHISHGUARD_SKIP_VERSION_BUMP=1` in Docker/CI, and review the diff before committing.

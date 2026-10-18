# PhishGuard Browser Extension: Agent Directives (`apps/extension`)

This document defines guidelines, constraints, and architecture for the Manifest V3 browser extension.

---

## 1. Responsibilities

The extension (`apps/extension`) is the client-side telemetry capture and edge inferencing engine. It consists of:
1. **Passive Content Script (`src/content/telemetry-collector.ts`):**
   - Samples pointer movements throttled to `requestAnimationFrame`. Computes normalized coordinates $[0, 1]$, instantaneous velocities, accelerations, and trajectory angles.
   - Measures keystroke dynamics (dwell times, flight times) without logging raw characters.
   - Observes DOM anomalies: elements with `opacity: 0`, cross-origin iframe crossings, and paste into password fields.
   - Injects full-page warning banner when phishing is flagged.
2. **Background Service Worker (`src/background/service-worker.ts`):**
   - Manages on-device student ONNX model inference session via `onnxruntime-web`.
   - Executes tri-state decision routing (`SAFE < 0.15`, `BLOCK > 0.85`, `AMBIGUOUS 0.15 - 0.85`).
   - Dispatches `EscalationPayload` asynchronously to `http://localhost:8000/v1/escalate` on ambiguous interactions.
3. **Popup Threat Inspector (`popup/popup.html`, `popup/popup.ts`):**
   - Displays real-time risk score meter, active domain, pointer/keystroke sample counts, and DOM anomalies.

---

## 2. Hard Constraints & Budget

- **RAM Budget:** Soft target of ~200 MiB peak RSS for the whole extension worker process (reported/warned, not enforced); hard sanity ceiling 512 MiB.
- **Inference Latency:** Target **< 40 ms** on-device inference time per interaction burst.
- **Privacy Compliance:** Under no circumstances should raw keystrokes or sensitive input values be recorded or stored.
- **Manifest V3 Requirements:** All background execution must occur within the Service Worker (`service-worker.ts`) or content scripts. Do not attempt to use deprecated persistent background pages or DOM access in service worker.

---

## 3. Development & Verification Commands

```powershell
# In apps/extension or root:
pnpm --filter @phishguard/extension test        # Run unit tests via tsx
pnpm --filter @phishguard/extension typecheck   # Typecheck without emit
pnpm --filter @phishguard/extension build       # Bundle extension via Vite to dist/
```

## Verified Runtime and Release Contracts

- `pnpm --filter @phishguard/extension typecheck` covers source, scripts, tests, popup, and options with Chrome and Node types; Vite owns emitted build output.
- Student-v2 ONNX inputs are float32 `trajectory` `[batch, 128, 6]`, `visual` `[batch, 3, 64, 64]`, and `page_context` `[batch, 16]`; metadata input-contract shapes omit the batch axis.
- Cloud escalation is manual only. Before sending evidence-v2 fields, require `/health` capabilities with telemetry evidence version 2, manual escalation enabled, and support for the active input contract. Automatic local evaluation does not call `/v1/escalate`.
- Packaged models require `student_model.metadata.json` matching the ONNX binary and validation artifacts in `apps/backend/models/v<model-version>/`. Docker packaging is local-only, uses newly owned temporary staging, and refuses to overwrite existing versioned archives.

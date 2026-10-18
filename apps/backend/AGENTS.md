# PhishGuard Backend Gateway: Agent Directives (`apps/backend`)

This document defines guidelines, constraints, and architecture for the FastAPI Escalation Gateway.

---

## 1. Responsibilities

The backend (`apps/backend`) is the cloud escalation orchestrator:
1. **Endpoint `POST /v1/escalate`:**
   - Validates incoming `EscalationPayload` using Pydantic v2.
   - Fast-paths through `ReputationCacheService` for known benign domains (e.g. Google, Microsoft) or cached analyses.
   - Dispatches cache misses to `CloudInferenceDispatcher` running the PyTorch Teacher model.
   - Returns a rich `CloudInferenceVerdict` with `actionOverride` (`ALLOW`, `WARN`, `BLOCK`) and human-readable `explanationReasons`.
   - When Gemini is configured it runs the Gemini ADK forensic teacher (screenshot, DOM topology and interaction dynamics), after the neutral reputation prior; verdicts use the `gemini-v1:{model}:` cache and degrade to `cloud-evidence-v2-fallback` (never a 429) when the breaker is open, the call budget is exhausted or Gemini fails. **The opt-in consented screenshot is forwarded to the Gemini API.** When unconfigured it is deterministic evidence-v2 (`cloud-evidence-v2`) with the plain verdict cache.
1b. **Endpoint `POST /v1/escalate/gemini`:** same `EscalationPayload` -> `CloudInferenceVerdict` contract, rate-limited per IP (20/min). Runs the Gemini ADK forensic teacher (`services/gemini_agent.py`) with deterministic fallback (`cloud-evidence-v2-fallback`) on missing key, errors, open circuit or exhausted `GEMINI_TEACHER_MAX_CALLS_PER_HOUR`. **It forwards the consented screenshot to the Gemini API.** Its verdict cache (shared with `/v1/escalate` when configured) is namespaced `gemini-v1:{model}:` and only successful Gemini verdicts are cached. Writes an audit row like `/v1/escalate`.
1c. **Playground `GET /v1/playground/scenarios`, `POST /v1/playground/scenarios/{id}/run`:** curated fixtures in `phishguard_backend/playground/scenarios/` (regenerate with `scripts/playground/render_scenarios.py`). A run executes evidence-v2 and the Gemini teacher concurrently and returns both with a tool-call trace. The run body may carry an optional user-recorded `interaction` (trajectory, keystroke timings, observed DOM events only): it replaces the fixture's behavior while url/domain/screenshot/topology evidence stay server-fixed. Rate-limited per IP (12/min). **The playground writes no audit rows.**
2. **Authentication Skeleton:**
   - Validates client Bearer tokens / API keys via `AuthGatewayService`.
   - Supports development bypass in `dev_mode = True` and strict validation in production mode.
3. **Telemetry Retraining Buffer:**
   - Prepares anonymized hard-negative telemetry samples for model fine-tuning.

---

## 2. Hard Constraints

- **Pydantic v2 Validation:** All input payloads must be validated against `phishguard_types.EscalationPayload` with `extra="forbid"`.
- **Response Format:** Responses must strictly conform to `phishguard_types.CloudInferenceVerdict`.
- **Stateless Gateway:** The gateway should remain stateless, leveraging Redis or cache services for reputation lookups and rate limiting.

---

## 3. Development & Verification Commands

```powershell
# Run API & integration test suite
.\.venv\Scripts\python.exe -m pytest apps/backend/tests/test_escalate_api.py -v

# Start local development server with hot-reload
.\.venv\Scripts\uvicorn phishguard_backend.main:app --host 0.0.0.0 --port 8000 --reload
```

## Verified Evidence-v2 Integration

- `GET /health` advertises telemetry evidence version 2, supported student input contracts, and manual escalation capability.
- Verdict cache fingerprints include resolved trusted client risk and its accepted validation-report SHA-256; payload claims alone do not establish trust.
- Reputation priors apply only to neutral evidence without a screenshot and with absent trusted client risk or risk below `0.15`.

## Gemini ADK Teacher

- `services/gemini_agent.py` runs an ADK `LlmAgent` ("PhishGuard Sentinel") behind `POST /v1/escalate` (when configured), `POST /v1/escalate/gemini` and the playground when a real `GEMINI_API_KEY`/`GOOGLE_API_KEY` (not empty/`CHANGE_ME*`) or Vertex mode is configured. Without credentials `POST /v1/escalate` runs the deterministic evidence-v2 heuristics; `/v1/escalate` has no per-IP limiter (cost is bounded by the call budget and breaker).
- `GeminiForensicTeacher._run_agent(content, state)` is the single network seam and returns `(text, tool_calls)`. Tests must stub it; no test may reach Gemini (`tests/conftest.py` clears credentials and resets the breaker, call budget and rate limiters).
- `cloud_inference.apply_safety_rails` is code-enforced: a registry-authorized host voids the brand claim, Gemini BLOCK below 0.70 becomes WARN, a baseline BLOCK is never downgraded, and a Gemini ALLOW cannot clear a baseline WARN (WARN floor: baseline confidence and reasons plus "No proof the page is safe; deterministic evidence keeps the warning").
- The tool-call trace lists only the two grounding tools (`verify_brand_official_domain`, `lookup_threat_memory_bank`); ADK's injected `set_model_response` is excluded.
- Degraded behaviour: a cancelled evaluation (client disconnect) releases the breaker probe and does not count as a failure; `lookup_threat_memory_bank` times out after 2 s and returns `available: false`; audit-row persistence is best-effort (commit failures are rolled back, logged by exception type, and never fail the verdict).
- Versions: `gemini-adk/<model>` on success; `cloud-evidence-v2-fallback` (with the "Automated fallback applied" reason) on the Gemini route when unconfigured, and on `/v1/escalate` when configured but erroring, timing out, with an open circuit or an exhausted call budget; `/v1/escalate` returns `cloud-evidence-v2` when unconfigured or on a neutral reputation-prior hit. Fallback verdicts are never cached.
- Screenshots are the full visible viewport at its real aspect ratio (extension downscales only above 2048 px on the longest side, JPEG, <= 1.5 MB); the schema accepts data URLs up to 2,100,000 chars and `services/vision.py` accepts images up to 2048 px per side (MobileNet still resizes to 224). The agent runs with high media resolution and medium thinking (Flash-Lite defaults to minimal, which can end a turn before the grounding tools are called).
- The agent follows a screen-content step first (brand shown, credential form, urgency cues, on-screen URL mismatch, command/QR lures, clone layout), then DOM topology and interaction dynamics, and returns `risk_score` plus an optional `screen_analysis`. The verdict exposes them as optional `riskScore` and `screenAnalysis` (`ScreenAnalysis`); deterministic, fallback and prior verdicts carry the baseline `riskScore` (priors may omit it) and no `screenAnalysis`.
- `apply_safety_rails` also governs the score: a registry-authorized host resets `riskScore` to the baseline and caps `screenRiskScore` at it, a baseline BLOCK keeps `riskScore >= baseline`, a WARN floor keeps `riskScore >= baseline`, and the score is finally clamped into the action band (ALLOW <= 0.15, WARN within 0.15-0.85, BLOCK >= 0.85). `screenAnalysis` is dropped when no screenshot was sent.
- Only the evidence brief (query keys, aggregate stats, screenshot dimensions) and the consented screenshot are sent to Gemini; log exception type names only.

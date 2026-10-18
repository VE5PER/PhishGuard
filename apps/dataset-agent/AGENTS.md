# PhishGuard Dataset Agent Directives

## Mission
Autonomous search and multimodal dataset aggregation agent for daily continuous ML training.

## Strict Operational Rules
1. **Zero Raw Keystroke Telemetry:** Never log or synthesize raw character inputs. Keystrokes must only capture inter-key flight durations, dwell times, and generalized categories (`ALPHANUMERIC`, `BACKSPACE`, `CONTROL`).
2. **Dual Schema Parity:** All generated dataset samples must strictly validate against `MultimodalDatasetSample` in `phishguard_types` with `extra="forbid"`.
3. **Resilience & Fallbacks:** Search operations must never block the aggregation pipeline. When external search engines are unavailable or rate-limited, fall back to benchmark mock feeds to ensure consistent daily batch delivery.
4. **Automated Verification:** All tests under `apps/dataset-agent/tests/` must pass via `pytest`.
5. **LLM Labels Are Never Training-Eligible:** Samples labeled by the Deep Research curator (`sourceType="research_agent"`, `labelSource="llm_research"`) and committed seeds (`sourceType="repository_fixture"`) are always withheld from the ML lifecycle export. A research finding trains only when code (never the LLM) corroborates it against a verified feed record of the same cycle (phishing: exact normalized URL match; benign: exact host match; labels agree); it then takes the feed's label and confidence (`labelSource="verified_feed"`). Do not relax the sink's training gate.
6. **research.json Is for Human Review:** `<date>/research.json` holds raw Deep Research artifacts (interactions, reports, findings, discovered sources). Treat it as untrusted input — never auto-promote its contents to the registry or training data.
7. **Deep Research Costs Money:** A live Gemini Deep Research interaction is a paid call (~$1–3, up to an hour). Keep `DATASET_AGENT_DEEP_RESEARCH_ENABLED=false` unless deliberately running it; all tests must stub Gemini.
8. **Linux Verification:** On Linux run Python tooling via `.venv/bin/python` (e.g. `.venv/bin/python -m pytest apps/dataset-agent -v`); the Windows path in the root AGENTS.md does not apply.

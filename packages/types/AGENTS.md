# PhishGuard Shared Contracts: Agent Directives (`packages/types`)

This document defines guidelines, constraints, and architecture for the shared data contracts and schemas.

---

## 1. Responsibilities

`packages/types` is the single source of truth for all wire formats, telemetry schemas, and inference payloads:
1. **TypeScript Definitions (`src/ts/`):**
   - Zod schemas and derived TypeScript types for the browser extension.
   - Built to `dist/` with `tsc`.
2. **Python Definitions (`src/py/phishguard_types/`):**
   - Pydantic v2 data models for the FastAPI backend and PyTorch ML engine.
   - Installed in editable mode (`pip install -e packages/types`).

---

## 2. Hard Constraints

- **Strict Parity:** Every schema field in Zod must have an exact equivalent in Pydantic v2 with matching types, bounds, and validations.
- **Forbid Extra Attributes:** All models must enforce `extra="forbid"` (Pydantic) and strict schema parsing (Zod) to prevent accidental telemetry leakage.
- **Privacy Assurance:** Never add fields that can capture unhashed or raw keystroke characters.

---

## 3. Development & Verification Commands

```powershell
# Run TypeScript contract tests
pnpm --filter @phishguard/types test

# Run Python Pydantic contract tests
.\.venv\Scripts\python.exe -m pytest packages/types/src/py/tests -v
```

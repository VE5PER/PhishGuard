---
name: phishguard-telemetry
description: >-
  Procedures and runbooks for inspecting, testing, and verifying client-side
  interaction telemetry (pointer kinematics, keystroke dwell/flight dynamics,
  and DOM topological anomalies) in PhishGuard.
---

# PhishGuard Telemetry Collection & Verification Runbook

This skill provides step-by-step procedures for validating passive client telemetry, privacy compliance, and on-device risk scoring.

---

## 1. Verifying Pointer Kinematics

Pointer movements are sampled throttled to `requestAnimationFrame` and normalized to the viewport $[0, 1]$.

### Key Invariants
- Coordinates $x, y \in [0, 1]$.
- Features per step: $[x, y, dx, dy, v, \theta]$.
- Velocity $v = \sqrt{dx^2 + dy^2}/\Delta t$ in px/ms.
- Acceleration $a = (v - v_{\text{prev}})/\Delta t$ in px/ms$^2$.
- Angle $\theta = \operatorname{atan2}(dy, dx)$ in radians $[-\pi, \pi]$.

### Verification Step
Run the on-device engine unit test:
```powershell
pnpm --filter @phishguard/extension test
```
Verify that `preprocessTrajectory` produces a `(128, 6)` Float32Array without NaN or infinity values.

---

## 2. Auditing Keystroke Privacy Compliance

Under GDPR and PCI-DSS, raw text inputs and character codes must **never** be captured.

### Checklist
1. Ensure `apps/extension/src/content/telemetry-collector.ts` uses `categorizeKey(e.key)` returning only:
   - `ALPHANUMERIC`
   - `BACKSPACE`
   - `CONTROL`
   - `OTHER`
2. Ensure neither `e.key`, `e.code`, nor char values are written to `keystrokes`.
3. Verify that Pydantic rejects extra attributes:
   ```powershell
   .\.venv\Scripts\python.exe -m pytest packages/types/src/py/tests/test_schemas.py -k "test_keystroke_dynamics_gdpr_safe" -v
   ```

---

## 3. DOM Topology & Anomaly Inspection

The content script monitors suspicious interactions:
- Clicks on elements with `opacity: 0` or `visibility: hidden`.
- Interactions targeting cross-origin `<iframe>` elements containing password inputs.
- Clipboard paste actions into `<input type="password">`.

### Verification Step
Inspect the tri-state routing test in `apps/extension/tests/test_onnx_engine.ts` to confirm that suspicious DOM interactions elevate the risk score into the `BLOCK` zone ($> 0.85$).

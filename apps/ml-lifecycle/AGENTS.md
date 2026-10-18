# PhishGuard ML Lifecycle: Agent Directives (`apps/ml-lifecycle`)

This document defines guidelines, operational constraints, and architecture for the Machine Learning training lifecycle, checkpoint management, and model promotion pipelines.

---

## 1. Responsibilities

The ML lifecycle application (`apps/ml-lifecycle`) orchestrates model progression from synthetic training to edge release:
1. **Checkpoint Progression (`checkpoints/`):**
   - `raw/`: Intermediate PyTorch training checkpoints (`.pt`) with optimizer states and epoch manifests.
   - `candidate/`: Validated checkpoints meeting loss and convergence criteria.
   - `onnx/`: Compiled edge models with opset 17 and dynamic batch axes.
   - `registry/`: Formal SemVer releases (`v1.0.0`, `v1.1.0`) with cryptographic SHA-256 manifests.
2. **Training & Distillation Pipelines (`src/phishguard_ml_lifecycle/training_pipeline.py`):**
   - Synthesizes physiological Bézier mouse dynamics with tremor noise ($8\text{ Hz}$).
   - Executes student training and teacher-student distillation with soft-probability KL divergence.
3. **Quality & Deployment Gates (`src/phishguard_ml_lifecycle/evaluator.py`):**
   - Accuracy threshold: $\ge 0.95$.
   - F1 score threshold: $\ge 0.95$.
   - Maximum inference latency: $\le 40\text{ ms}$ on CPU.
   - Tri-State routing calibration check: benign mouse movements $< 0.40$, phishing movements $> 0.60$.
4. **Export & Promotion (`src/phishguard_ml_lifecycle/export_pipeline.py`, `promotion.py`):**
   - Exports PyTorch checkpoints into ONNX binaries with dynamic batch dimensions.
   - Promotes and synchronizes releases to `apps/backend/models/vX.Y.Z` and `apps/extension/public/models/student_model.onnx`.

---

## 2. Hard Constraints

- **Edge Binary Size Limit:** ONNX models for browser deployment must remain **$< 80\text{ MB}$** (current student models are $\sim 107\text{ KB}$).
- **Sequence Dimension:** Trajectory input tensors must strictly match shape `(batch_size, 128, 6)`.
- **Privacy Preservation:** Under no circumstance should raw keystrokes, key labels, or DOM text be logged in checkpoint manifests or training metadata.
- **Dual Verification:** All exported ONNX checkpoints must pass `onnx.checker.check_model` and SHA-256 checksum verification before promotion.

---

## 3. Development & Verification Commands

```bash
# Run ML lifecycle tests
./.venv/bin/pytest apps/ml-lifecycle/tests -v

# Run training via CLI
./.venv/bin/python -m phishguard_ml_lifecycle.cli train --epochs 5 --samples 128

# List all tracked checkpoints
./.venv/bin/python -m phishguard_ml_lifecycle.cli list
```

## Verified Student-v2 Release Artifacts

- Student-v2 graph inputs are float32 `trajectory` `[batch, 128, 6]`, `visual` `[batch, 3, 64, 64]`, and `page_context` `[batch, 16]`.
- A v2 release binds its ONNX SHA-256 to `evaluation-with-source.json`, `runtime-acceptance.json`, and `runtime-evidence.json`; keep these reports with the versioned registry artifacts.

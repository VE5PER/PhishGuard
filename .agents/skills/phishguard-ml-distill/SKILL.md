---
name: phishguard-ml-distill
description: >-
  Runbook for synthesizing Bézier trajectories, training the BehavioralCNNLSTM network,
  distilling the student model, and exporting/quantizing ONNX models for on-device
  browser inferencing in PhishGuard.
---

# PhishGuard ML Distillation & ONNX Export Runbook

This skill guides the agent through training, evaluating, and exporting behavioral machine learning models.

---

## 1. Synthesizing Trajectory Curves

Use the Bézier synthesizer to generate realistic human mouse curves with physiological tremor noise:

```python
from phishguard_ml_engine.data import synthesize_human_trajectory_curve

# Generates 128-step trajectory with 8 Hz physiological tremor
points = synthesize_human_trajectory_curve(
    start=(0.1, 0.2),
    end=(0.8, 0.9),
    num_steps=128,
    jitter_std=0.002,
    tremor_freq=8.0,
    tremor_amp=0.003,
)
```

Verify synthesizer behavior:
```powershell
.\.venv\Scripts\python.exe -m pytest packages/ml-engine/tests/test_trajectory_loader.py -v
```

---

## 2. Knowledge Distillation Training

The student model learns to mimic the Teacher model's calibrated soft-probability predictions while remaining compact (< 80 MB) and fast (< 40 ms):

```python
from phishguard_ml_engine.training.train_student import run_synthetic_training_benchmark

results = run_synthetic_training_benchmark(epochs=5, num_samples=128)
print("Distillation loss:", results["final_loss"])
```

---

## 3. ONNX Model Export

Export the student model for in-browser execution with dynamic batch axes:

```python
from phishguard_ml_engine.export.export_onnx import export_student_to_onnx

export_path = export_student_to_onnx(
    output_path="apps/extension/public/models/student_model.onnx",
    seq_length=128,
    include_visual=False,
)
print("Exported to:", export_path)
```

### Verification Step
```powershell
.\.venv\Scripts\python.exe -m pytest packages/ml-engine/tests/test_model_export.py -k "test_onnx_export" -v
```
Check that the exported file is under 80 MB (current size: $\sim 107$ KB).

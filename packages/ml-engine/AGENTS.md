# PhishGuard ML Engine: Agent Directives (`packages/ml-engine`)

This document defines guidelines, constraints, and architecture for the Machine Learning and Distillation Engine.

---

## 1. Responsibilities

The ML engine (`packages/ml-engine`) handles data synthesis, model architectures, distillation, and ONNX export:
1. **Synthetic Bézier Trajectory Generation (`data/bezier_synthesizer.py`):**
   - Synthesizes human-like mouse trajectories using cubic Bézier curves with minimum-jerk kinematics.
   - Injects neuromuscular tremor noise ($\sim 8$ Hz) and Gaussian jitter to emulate authentic human physiology and phishing hesitation patterns.
2. **PyTorch Trajectory Dataset & Loader (`data/trajectory_dataset.py`):**
   - Resamples variable-length mouse point streams into fixed sequence length $T = 128$.
   - Constructs 6 kinematic channels: $[x, y, dx, dy, v, \theta]$.
   - Generates batched tensors of shape `(B, 128, 6)`.
3. **Model Architectures (`models/`):**
   - `BehavioralCNNLSTM`: 1D-CNN temporal feature extractor + BiLSTM with temporal attention pooling.
   - `DistilledStudentModel`: Lightweight on-device student model combining behavioral and optional visual branches into calibrated risk probabilities in $[0, 1]$.
   - `TeacherMultimodalModel`: Multimodal cloud teacher model combining Vision, DOM, and Behavioral dynamics with late cross-attention fusion.
4. **Distillation & ONNX Export (`training/`, `export/`):**
   - Distillation pipeline minimizing BCE + KL divergence against Teacher soft logits.
   - Exports student model to ONNX format with dynamic batch axes (`export_onnx.py`).

---

## 2. Hard Constraints

- **On-Device Target Size:** Student ONNX model size must be **< 80 MB** (current checkpoint is $\sim 107$ KB).
- **Fixed Sequence Length:** All pointer sequences fed into behavioral networks must be resampled to exactly $T = 128$ steps.
- **Export Standards:** Always export models with dynamic batch axes for inference flexibility, `opset_version=17`, and `dynamo=False` for robust cross-platform compatibility.

---

## 3. Development & Verification Commands

```powershell
# Run ML engine unit tests
.\.venv\Scripts\python.exe -m pytest packages/ml-engine/tests -v

# Export latest student model to ONNX
.\.venv\Scripts\python.exe -c "from phishguard_ml_engine.export.export_onnx import export_student_to_onnx; export_student_to_onnx(output_path='apps/extension/public/models/student_model.onnx')"
```

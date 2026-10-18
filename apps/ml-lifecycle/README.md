# PhishGuard ML Lifecycle & Model Checkpoint Hub (`apps/ml-lifecycle`)

This application manages the machine learning lifecycle for PhishGuard: training orchestration, knowledge distillation, checkpoint persistence, quality evaluation gates, ONNX edge compilation, and model registry promotion.

---

## Architecture Overview

```
apps/ml-lifecycle/
├── checkpoints/              # Checkpoint storage hierarchy
│   ├── raw/                  # PyTorch training checkpoints (.pt)
│   ├── candidate/            # Quality-filtered candidate models
│   ├── onnx/                 # Compiled edge ONNX binaries
│   └── registry/             # Production SemVer releases with manifests
├── configs/                  # Training, distillation, and evaluation configs
│   ├── student_baseline.json
│   ├── student_advanced.json
│   └── teacher_multimodal.json
├── src/phishguard_ml_lifecycle/
│   ├── checkpoint_manager.py # Checkpoint persistence, hashing & pruning
│   ├── training_pipeline.py  # Student & teacher training pipelines
│   ├── evaluator.py          # Deployment gates & latency benchmarking
│   ├── export_pipeline.py    # ONNX compilation & verification
│   ├── promotion.py          # Release promotion to backend & extension
│   └── cli.py                # Command-line interface
└── tests/                    # Automated test suite
```

---

## Checkpoint Lifecycle Workflow

```
[Training Pipeline]
        │
        ▼ (epoch / step)
  checkpoints/raw/ (.pt + metadata)
        │
        ▼ (passes validation loss & convergence)
  checkpoints/candidate/ (.pt + candidate manifest)
        │
        ▼ (ModelExportPipeline -> ONNX opset 17)
  checkpoints/onnx/ (.onnx + verification manifest)
        │
        ▼ (ModelPromoter -> SemVer promotion)
  checkpoints/registry/vX.Y.Z/
        ├── manifest.json
        └── student_model.onnx
        │
        ├──► apps/backend/models/vX.Y.Z/student_model.onnx (Cloud Registry)
        └──► apps/extension/public/models/student_model.onnx (Browser Edge)
```

---

## Quickstart & CLI Commands

### 1. Train a Student Model
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli train \
  --config configs/student_baseline.json \
  --epochs 5 \
  --samples 128
```

### 2. Distill Student from Teacher
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli train \
  --distill \
  --epochs 5 \
  --samples 128
```

### 3. Evaluate a Checkpoint
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli evaluate \
  --checkpoint checkpoints/candidate/candidate_best.pt
```

### 4. Export to ONNX
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli export \
  --checkpoint checkpoints/candidate/candidate_best.pt \
  --version 1.2.0
```

### 5. Promote to Production Registry
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli promote \
  --onnx checkpoints/onnx/student_model_1.2.0.onnx \
  --version 1.2.0 \
  --name "phishguard-student-v1.2.0"
```

### 6. List Tracked Checkpoints
```bash
./.venv/bin/python -m phishguard_ml_lifecycle.cli list
```

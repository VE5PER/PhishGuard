"""Unit tests for ML models, training benchmark, and ONNX export."""

import os
import tempfile
import torch
import pytest

from phishguard_ml_engine.models import (
    BehavioralCNNLSTM,
    DistilledStudentModel,
    TeacherMultimodalModel,
)
from phishguard_ml_engine.training.train_student import run_synthetic_training_benchmark
from phishguard_ml_engine.export.export_onnx import export_student_to_onnx


def test_behavioral_cnn_lstm_forward():
    model = BehavioralCNNLSTM(in_channels=6, cnn_channels=32, lstm_hidden_dim=32)
    x = torch.randn(4, 128, 6)
    out = model(x)
    assert out.shape == (4, 1)
    # Calibrated risk must be in [0, 1]
    assert (out >= 0.0).all() and (out <= 1.0).all()

    # Test feature extraction embedding shape (B, 64)
    emb = model.extract_features(x)
    assert emb.shape == (4, 64)


def test_student_model_multimodal():
    # Behavioral only
    student_b = DistilledStudentModel(behavioral_dim=32, include_visual=False)
    x_b = torch.randn(2, 128, 6)
    out_b = student_b(x_b)
    assert out_b.shape == (2, 1)
    assert (out_b >= 0.0).all() and (out_b <= 1.0).all()

    # Multimodal (behavioral + visual)
    student_mm = DistilledStudentModel(behavioral_dim=32, visual_dim=16, include_visual=True)
    x_v = torch.randn(2, 3, 64, 64)
    out_mm = student_mm(x_b, x_v)
    assert out_mm.shape == (2, 1)
    assert (out_mm >= 0.0).all() and (out_mm <= 1.0).all()


def test_teacher_multimodal_forward():
    teacher = TeacherMultimodalModel(vision_dim=32, dom_dim=16, dynamics_dim=32, fusion_dim=32)
    traj = torch.randn(2, 128, 6)
    vision = torch.randn(2, 32)
    dom = torch.randn(2, 16)

    probs, logits = teacher(traj, vision, dom)
    assert probs.shape == (2, 1)
    assert logits.shape == (2, 1)
    assert (probs >= 0.0).all() and (probs <= 1.0).all()


def test_training_benchmark_runs():
    res = run_synthetic_training_benchmark(epochs=2, num_samples=16)
    assert "final_loss" in res
    assert res["final_loss"] > 0.0


def test_onnx_export():
    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_file = os.path.join(tmpdir, "student_test.onnx")
        res_path = export_student_to_onnx(output_path=onnx_file, seq_length=128, include_visual=False)
        assert os.path.exists(res_path)
        file_size_bytes = os.path.getsize(res_path)
        # Verify file is populated and lightweight (< 10 MB)
        assert 1000 < file_size_bytes < 10 * 1024 * 1024

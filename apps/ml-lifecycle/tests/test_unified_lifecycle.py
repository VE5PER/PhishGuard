"""Comprehensive verification of the Unified Ultra-Lightweight ML Lifecycle for PhishGuard."""

from pathlib import Path
import tempfile
import numpy as np
import pytest
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from phishguard_ml_lifecycle import (
    PhishGuardUnifiedModel,
    MobileNetV4ConvSmall050,
    KinematicDynamicsBackbone,
    FocalBrierCalibrationLoss,
    build_warmup_cosine_scheduler,
    normalize_viewport_image,
    preprocess_interaction_sequence,
    create_multimodal_dataloader,
    train_unified_model,
    export_static_onnx,
    quantize_model_int8,
    verify_onnx_divergence,
    SessionCalibrationDataReader,
)


def test_visual_stream_preprocessing_contract():
    # Raw synthetic viewport image (H, W, 3) in [0, 255]
    raw_img = np.random.randint(0, 256, (300, 400, 3), dtype=np.uint8)
    norm_tensor = normalize_viewport_image(raw_img, target_size=(224, 224))

    assert isinstance(norm_tensor, torch.Tensor)
    assert norm_tensor.shape == (3, 224, 224)
    assert norm_tensor.dtype == torch.float32

    # Check ImageNet normalization: values should be centered roughly around 0
    mean_val = float(norm_tensor.mean())
    assert -2.5 < mean_val < 2.5


def test_kinematic_stream_preprocessing_contract():
    # 40 interaction events (less than 64 frames, testing zero-padding)
    events = [
        {
            "x": 0.1 + i * 0.01,
            "y": 0.2 + i * 0.01,
            "velocity": 120.0 + i * 2,
            "angle": 0.5,
            "eventType": "move" if i < 35 else "click",
        }
        for i in range(40)
    ]

    tensor = preprocess_interaction_sequence(events, seq_length=64)
    assert isinstance(tensor, torch.Tensor)
    assert tensor.shape == (5, 64)
    assert tensor.dtype == torch.float32

    # Leftmost 24 steps should be zero-padded
    assert torch.all(tensor[:, :24] == 0.0)
    # Rightmost 40 steps should be populated
    assert tensor[0, 24] > 0.0
    # Channel bounds:
    # Channel 0 (x) in [0, 1]
    assert 0.0 <= tensor[0].min() and tensor[0].max() <= 1.0
    # Channel 1 (y) in [0, 1]
    assert 0.0 <= tensor[1].min() and tensor[1].max() <= 1.0
    # Channel 2 (v) in [0, 1]
    assert 0.0 <= tensor[2].min() and tensor[2].max() <= 1.0
    # Channel 3 (delta_theta) in [-1, 1]
    assert -1.0 <= tensor[3].min() and tensor[3].max() <= 1.0
    # Channel 4 (event) in {0.0, 0.33, 0.66, 1.0}
    assert tensor[4, -1] == pytest.approx(0.66, abs=0.01)  # 'click'


def test_model_architecture_parameter_budgets():
    model = PhishGuardUnifiedModel()
    breakdown = model.count_parameters()

    # Budget assertions per spec:
    # Vision Backbone: < 3.5M parameters
    assert breakdown["vision_backbone"] < 3_500_000
    # Kinematic Dynamics Backbone: < 25K parameters
    assert breakdown["dynamics_backbone"] < 25_000
    # Total Model Parameters: < 4M parameters
    assert breakdown["total_parameters"] < 4_000_000

    # Total size in FP32 (< 16 MB)
    fp32_mb = (breakdown["total_parameters"] * 4) / (1024 * 1024)
    assert fp32_mb < 16.0


def test_unified_model_forward_and_latency():
    model = PhishGuardUnifiedModel().eval()
    batch_size = 2
    viewport = torch.randn(batch_size, 3, 224, 224)
    dynamics = torch.randn(batch_size, 5, 64)

    # Standard forward returns risk probabilities in [0, 1]
    probs = model(viewport, dynamics)
    assert probs.shape == (batch_size, 1)
    assert torch.all(probs >= 0.0) and torch.all(probs <= 1.0)

    # With return_logits=True for focal loss optimization
    probs, logits = model(viewport, dynamics, return_logits=True)
    assert logits.shape == (batch_size, 1)
    assert torch.allclose(torch.sigmoid(logits), probs, atol=1e-5)

    # Single-pass inference latency test (< 20 ms on CPU)
    import time
    vp_single = torch.randn(1, 3, 224, 224)
    dyn_single = torch.randn(1, 5, 64)
    latencies = []
    with torch.no_grad():
        for _ in range(10):
            t0 = time.perf_counter()
            _ = model(vp_single, dyn_single)
            latencies.append((time.perf_counter() - t0) * 1000.0)

    avg_latency = float(np.mean(latencies[2:]))  # discard warmups
    assert avg_latency < 20.0, f"Inference latency {avg_latency:.2f}ms exceeded 20ms threshold"


def test_focal_brier_calibration_loss():
    criterion = FocalBrierCalibrationLoss(alpha=0.65, gamma=2.0, brier_lambda=0.1)

    logits = torch.tensor([[2.0], [-2.0], [0.0]], dtype=torch.float32)
    targets = torch.tensor([[1.0], [0.0], [1.0]], dtype=torch.float32)

    total_loss, focal_loss, brier_loss = criterion(logits, targets)

    assert total_loss > 0.0
    assert focal_loss > 0.0
    assert brier_loss > 0.0
    assert torch.isclose(total_loss, focal_loss + 0.1 * brier_loss, atol=1e-5)


def test_warmup_cosine_scheduler():
    model = nn.Linear(10, 2)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    scheduler = build_warmup_cosine_scheduler(optimizer, warmup_epochs=3, total_epochs=25)

    lrs = []
    for _ in range(25):
        lrs.append(optimizer.param_groups[0]["lr"])
        optimizer.step()
        scheduler.step()

    # Linear warmup across first 3 epochs: lr should strictly increase
    assert lrs[0] < lrs[1] < lrs[2]
    # Cosine annealing after epoch 3: lr should decrease
    assert lrs[3] > lrs[-1]


def test_unified_training_loop():
    # Create miniature dataset
    samples = [
        {
            "viewport": np.random.randn(224, 224, 3).astype(np.float32),
            "dynamics": [
                {"x": 0.1, "y": 0.2, "velocity": 10.0, "angle": 0.1, "eventType": "move"}
            ] * 20,
            "label": float(i % 2),
        }
        for i in range(16)
    ]

    train_loader = create_multimodal_dataloader(samples[:12], batch_size=4, shuffle=True, augment=True)
    val_loader = create_multimodal_dataloader(samples[12:], batch_size=4, shuffle=False, augment=False)

    model = PhishGuardUnifiedModel()
    res = train_unified_model(
        model=model,
        train_loader=train_loader,
        val_loader=val_loader,
        epochs=3,
        warmup_epochs=1,
        lr=1e-3,
    )

    assert len(res["history"]) == 3
    assert "val_loss" in res["final_metrics"]
    assert "val_accuracy" in res["final_metrics"]


def test_static_onnx_export_and_int8_quantization_verification():
    model = PhishGuardUnifiedModel().eval()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        fp32_path = tmp_path / "model_fp32.onnx"
        int8_path = tmp_path / "model_int8.onnx"

        # 1. Static Export with Opset 18
        exported_path = export_static_onnx(model, fp32_path, opset_version=18)
        assert exported_path.exists()

        # 2. INT8 Quantization with Calibration Data Reader (50 samples for speed in test)
        reader = SessionCalibrationDataReader(num_samples=50)
        quantized_path = quantize_model_int8(
            fp32_onnx_path=exported_path,
            int8_onnx_path=int8_path,
            calibration_data_reader=reader,
        )
        assert quantized_path.exists()

        # File size constraints: INT8 sub-10 MB (and sub-5 MB)
        int8_size_mb = quantized_path.stat().st_size / (1024 * 1024)
        assert int8_size_mb < 5.0, f"INT8 size {int8_size_mb:.2f}MB exceeded 5MB limit"

        # 3. Automated Numerical Divergence Verification: MaxAbsoluteError <= 0.02
        report = verify_onnx_divergence(
            model=model,
            int8_onnx_path=quantized_path,
            num_test_samples=25,
            tolerance=0.02,
        )

        assert report["passed"] is True
        assert report["max_absolute_error"] <= 0.02

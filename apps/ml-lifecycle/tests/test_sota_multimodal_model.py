"""Unit tests for PhishGuardSOTAMultimodalModel architecture, latency, and explainability."""

import time
import numpy as np
import pytest
import torch

from phishguard_ml_lifecycle import PhishGuardSOTAMultimodalModel


def test_sota_model_parameter_budgets():
    model = PhishGuardSOTAMultimodalModel()
    breakdown = model.count_parameters()

    assert breakdown["vision_backbone"] < 3_500_000
    assert breakdown["dynamics_backbone"] < 25_000
    assert breakdown["total_parameters"] < 4_000_000

    # Total size in FP32 (< 16 MB)
    fp32_mb = (breakdown["total_parameters"] * 4) / (1024 * 1024)
    assert fp32_mb < 5.0, f"Model size {fp32_mb:.2f}MB exceeded 5MB threshold"


def test_sota_model_forward_and_optional_modalities():
    model = PhishGuardSOTAMultimodalModel().eval()
    b_size = 2

    vp = torch.randn(b_size, 3, 224, 224)
    dyn = torch.randn(b_size, 5, 64)
    url = torch.randn(b_size, 32)
    hid = torch.randn(b_size, 16)
    logo = torch.randn(b_size, 16)
    det = torch.randn(b_size, 16)

    # 1. Full 5-stream forward pass
    probs = model(vp, dyn, url, hid, logo, det)
    assert probs.shape == (b_size, 1)
    assert torch.all(probs >= 0.0) and torch.all(probs <= 1.0)

    # 2. Return logits mode
    probs, logits = model(vp, dyn, url, hid, logo, det, return_logits=True)
    assert logits.shape == (b_size, 1)
    assert torch.allclose(torch.sigmoid(logits), probs, atol=1e-5)

    # 3. Optional modalities fallback (edge-only mode)
    probs_edge = model(vp, dyn)
    assert probs_edge.shape == (b_size, 1)
    assert torch.all(probs_edge >= 0.0) and torch.all(probs_edge <= 1.0)


def test_sota_model_explain_prediction():
    model = PhishGuardSOTAMultimodalModel().eval()
    vp = torch.randn(1, 3, 224, 224)
    dyn = torch.randn(1, 5, 64)
    url = torch.randn(1, 32)
    hid = torch.randn(1, 16)
    logo = torch.randn(1, 16)
    det = torch.randn(1, 16)

    explanation = model.explain_prediction(vp, dyn, url, hid, logo, det)
    assert isinstance(explanation, dict)
    assert "screen_visual" in explanation
    assert "mouse_dynamics" in explanation
    assert "url_features" in explanation
    assert "logo_grounding" in explanation
    assert "ui_element_detection" in explanation

    total_pct = sum(explanation.values())
    assert pytest.approx(1.0, abs=0.05) == total_pct


def test_sota_model_inference_latency():
    model = PhishGuardSOTAMultimodalModel().eval()
    vp = torch.randn(1, 3, 224, 224)
    dyn = torch.randn(1, 5, 64)
    url = torch.randn(1, 32)
    hid = torch.randn(1, 16)
    logo = torch.randn(1, 16)
    det = torch.randn(1, 16)

    latencies = []
    with torch.no_grad():
        for _ in range(12):
            t0 = time.perf_counter()
            _ = model(vp, dyn, url, hid, logo, det)
            latencies.append((time.perf_counter() - t0) * 1000.0)

    # Discard warmup calls
    avg_latency = float(np.mean(latencies[3:]))
    assert avg_latency < 25.0, f"Average inference latency {avg_latency:.2f}ms exceeded 25ms limit"

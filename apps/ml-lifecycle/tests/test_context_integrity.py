from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
import torch

from phishguard_ml_lifecycle.context_corpus import build_context_corpus, audit_context_corpus, ContextStudentDataset
from phishguard_ml_lifecycle.context_training import metrics_and_gates
from phishguard_ml_engine.models.student_model import DistilledStudentModel


ROOT = Path(__file__).resolve().parents[3]


def test_corpus_disjoint_and_missing_regimes():
    corpus = build_context_corpus(ROOT, max_sources=20)
    audit_context_corpus(corpus)
    assert any(record["label"] is None for record in corpus["records"])
    assert any(record["scenario"] == "benign_content" for record in corpus["records"])
    groups = {split: {r["group"] for r in corpus["records"] if r["split"] == split} for split in ("train", "val", "test")}
    assert not groups["train"] & groups["val"]
    assert not groups["train"] & groups["test"]
    assert not groups["val"] & groups["test"]
    dataset = ContextStudentDataset(ROOT, corpus, "test")
    for index, record in enumerate(dataset.records):
        if record["mode"] == "neither":
            trajectory, visual, context, _, _ = dataset[index]
            assert not trajectory.any() and not visual.any()
            assert context[12] == 0 and context[13] == 0 and context[14] == 1
            break
    corrupted = deepcopy(corpus)
    corrupted["records"][0]["label"] = 0.25
    with pytest.raises(ValueError, match="digest"):
        audit_context_corpus(corrupted)


def test_metrics_fail_closed_and_policy_not_added():
    report = metrics_and_gates(np.array([0.01, 0.99]), np.array([0.0, 1.0]), np.array([0.05, 0.90]))
    assert not report["gate_failures"]
    assert report["tp"] == 1 and report["tn"] == 1
    bad = metrics_and_gates(np.array([0.99, 0.01]), np.array([0.0, 1.0]), np.array([0.05, 0.90]))
    assert "benign_warning_count" in bad["gate_failures"]
    with pytest.raises(ValueError):
        metrics_and_gates(np.array([float("nan"), 0.9]), np.array([0.0, 1.0]), np.array([0.05, 0.90]))
    with pytest.raises(ValueError):
        metrics_and_gates(np.array([0.1]), np.array([0.0]), np.array([0.05]))


def test_context_student_requires_context_and_masks_behavior():
    torch.manual_seed(0)
    model = DistilledStudentModel(behavioral_dim=64, include_visual=True, include_page_context=True).eval()
    context = torch.zeros(1, 16)
    context[:, 14] = 1
    with pytest.raises(ValueError, match="page_context"):
        model(torch.zeros(1, 128, 6), torch.zeros(1, 3, 64, 64))
    with torch.no_grad():
        left = model(torch.zeros(1, 128, 6), torch.zeros(1, 3, 64, 64), context)
        right = model(torch.randn(1, 128, 6), torch.ones(1, 3, 64, 64), context)
    torch.testing.assert_close(left, right)


def test_transport_context_cannot_change_model_risk():
    torch.manual_seed(0)
    model = DistilledStudentModel(behavioral_dim=64, include_visual=True, include_page_context=True).eval()
    context = torch.rand(1, 16)
    other = context.clone()
    context[:, 15] = 1
    other[:, 15] = 0
    trajectory = torch.rand(1, 128, 6)
    visual = torch.rand(1, 3, 64, 64)
    with torch.no_grad():
        left, right = model(trajectory, visual, context), model(trajectory, visual, other)
    torch.testing.assert_close(left, right, atol=0, rtol=0)

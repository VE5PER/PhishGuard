"""Tests for CheckpointManager functionality."""

import json
from pathlib import Path
import tempfile
import pytest
import torch
import torch.nn as nn
import torch.optim as optim

from phishguard_ml_lifecycle.checkpoint_manager import (
    CheckpointManager,
    compute_file_sha256,
)


class DummyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(6, 1)

    def forward(self, x):
        return self.fc(x)


def test_checkpoint_manager_init():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        assert manager.raw_dir.exists()
        assert manager.candidate_dir.exists()
        assert manager.onnx_dir.exists()
        assert manager.registry_dir.exists()


def test_save_and_load_raw_checkpoint():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        model = DummyModel()
        optimizer = optim.SGD(model.parameters(), lr=0.01)

        chk_path = manager.save_raw_checkpoint(
            model=model,
            optimizer=optimizer,
            epoch=1,
            step=50,
            loss=0.42,
            metrics={"val_loss": 0.40, "val_accuracy": 0.96},
            config={"model_name": "dummy-test"},
            checkpoint_id="chk_test_01",
        )

        assert chk_path.exists()
        manifest_path = manager.raw_dir / "chk_test_01.json"
        assert manifest_path.exists()

        with open(manifest_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
            assert meta["checkpoint_id"] == "chk_test_01"
            assert meta["stage"] == "raw"
            assert meta["epoch"] == 1
            assert meta["loss"] == 0.42
            assert meta["metrics"]["val_accuracy"] == 0.96

        # Test loading
        new_model = DummyModel()
        new_opt = optim.SGD(new_model.parameters(), lr=0.01)
        loaded_data = manager.load_checkpoint(chk_path, new_model, new_opt)

        assert loaded_data["epoch"] == 1
        assert loaded_data["step"] == 50

        # Verify weights match
        for p1, p2 in zip(model.parameters(), new_model.parameters()):
            assert torch.equal(p1, p2)


def test_promote_to_candidate(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        model = DummyModel()

        raw_path = manager.save_raw_checkpoint(
            model=model,
            epoch=2,
            step=100,
            loss=0.35,
            checkpoint_id="chk_raw_for_cand",
        )

        with pytest.raises(ValueError, match="validated hash-bound report"):
            manager.promote_to_candidate(raw_path, evaluation_metrics={})

        repo_root = Path(__file__).resolve().parents[3]
        candidate_dir = repo_root / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate"
        report_path = candidate_dir / "evaluation-with-source.json"
        report = json.loads(report_path.read_text())
        unit_report = {**report, "source_checkpoint_sha256": compute_file_sha256(raw_path)}
        from phishguard_ml_lifecycle import release_validation
        monkeypatch.setattr(
            release_validation, "validate_context_release",
            lambda model, measured_report, corpus: {"report": unit_report},
        )
        candidate_path = manager.promote_to_candidate(
            raw_checkpoint_path=raw_path,
            evaluation_metrics={},
            notes="Passed validation gates",
            evaluation_report=report_path,
            candidate_onnx=candidate_dir / "student_model.onnx",
            corpus_manifest=repo_root / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json",
        )

        assert candidate_path.exists()
        assert candidate_path.parent == manager.candidate_dir

        cand_manifest = candidate_path.with_suffix(".json")
        assert cand_manifest.exists()
        with open(cand_manifest, "r", encoding="utf-8") as f:
            meta = json.load(f)
            assert meta["stage"] == "candidate"
            assert meta["metrics"]["accuracy"] == report["metrics"]["accuracy"]
            assert meta["extra_notes"] == "Passed validation gates"

        monkeypatch.setattr(
            release_validation, "validate_context_release", lambda *args: {"report": report},
        )
        with pytest.raises(ValueError, match="does not bind this raw checkpoint"):
            manager.promote_to_candidate(
                raw_path, evaluation_metrics={}, evaluation_report=report_path,
                candidate_onnx=candidate_dir / "student_model.onnx",
                corpus_manifest=repo_root / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json",
            )


def test_prune_raw_checkpoints():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        model = DummyModel()

        # Save 4 checkpoints with different losses
        manager.save_raw_checkpoint(model=model, epoch=1, loss=0.50, checkpoint_id="chk_1")
        manager.save_raw_checkpoint(model=model, epoch=2, loss=0.30, checkpoint_id="chk_2")
        manager.save_raw_checkpoint(model=model, epoch=3, loss=0.20, checkpoint_id="chk_3")
        manager.save_raw_checkpoint(model=model, epoch=4, loss=0.40, checkpoint_id="chk_4")

        # Keep top 2 with lowest loss
        deleted = manager.prune_raw_checkpoints(keep_best_k=2, metric="loss", mode="min")
        assert len(deleted) == 2

        remaining = manager.list_checkpoints(stage="raw")
        assert len(remaining) == 2
        remaining_ids = {r["checkpoint_id"] for r in remaining}
        assert "chk_3" in remaining_ids  # loss 0.20
        assert "chk_2" in remaining_ids  # loss 0.30

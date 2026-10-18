"""Tests for TrainingPipeline, ModelEvaluator, and ModelExportPipeline."""

from pathlib import Path
import tempfile
import pytest
import torch

from phishguard_ml_lifecycle.checkpoint_manager import CheckpointManager
from phishguard_ml_lifecycle.training_pipeline import TrainingPipeline
from phishguard_ml_lifecycle.evaluator import ModelEvaluator
from phishguard_ml_lifecycle.export_pipeline import ModelExportPipeline
from phishguard_ml_engine.models.student_model import DistilledStudentModel


def test_student_training_and_checkpoint_creation():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        pipeline = TrainingPipeline(checkpoint_manager=manager)

        config = {
            "model_name": "test-student",
            "seq_length": 64,
            "behavioral_in_channels": 6,
            "behavioral_dim": 32,
            "hyperparameters": {
                "epochs": 2,
                "batch_size": 16,
                "learning_rate": 0.01,
            },
        }

        result = pipeline.train_student(config=config, num_samples=32)

        assert result["epochs_completed"] == 2
        assert result["best_checkpoint_path"] is not None
        assert Path(result["best_checkpoint_path"]).exists()

        checkpoints = manager.list_checkpoints(stage="raw")
        assert len(checkpoints) >= 1


def test_distillation_requires_an_explicit_validated_teacher():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        pipeline = TrainingPipeline(checkpoint_manager=manager)

        config = {
            "model_name": "test-distill-student",
            "seq_length": 64,
            "hyperparameters": {
                "epochs": 2,
                "batch_size": 16,
            },
        }

        with pytest.raises(ValueError, match="explicitly trained, validated teacher"):
            pipeline.train_distillation(config=config, num_samples=32)


def test_model_evaluator_metrics():
    model = DistilledStudentModel(behavioral_in_channels=6, behavioral_dim=32, include_visual=False)
    evaluator = ModelEvaluator(min_accuracy=0.50, min_f1=0.50, max_latency_ms=100.0)

    report = evaluator.evaluate_model(model, test_samples=20, seq_length=64)
    assert report.model_name is not None
    assert "accuracy" in report.metrics
    assert "f1_score" in report.metrics
    assert report.latency_ms_avg > 0


def test_model_export_pipeline():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        model = DistilledStudentModel(behavioral_in_channels=6, behavioral_dim=64, include_visual=False)

        # Save candidate checkpoint
        raw_chk = manager.save_raw_checkpoint(model=model, epoch=1, loss=0.1)
        cand_chk = raw_chk

        # Export to ONNX
        exporter = ModelExportPipeline(checkpoint_manager=manager)
        onnx_path = exporter.export_checkpoint(cand_chk, version_label="test_v1", seq_length=128)

        assert onnx_path.exists()
        assert onnx_path.suffix == ".onnx"

        manifest_path = manager.onnx_dir / "student_model_test_v1.json"
        assert manifest_path.exists()

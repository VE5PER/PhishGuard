"""Tests for the on-device visual student: canonical preprocessing, training, export and evaluation."""

import json
from pathlib import Path
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import pytest
import torch
from PIL import Image

from phishguard_ml_engine.models.student_model import DistilledStudentModel
from phishguard_ml_lifecycle.checkpoint_manager import CheckpointManager
from phishguard_ml_lifecycle.dataset import rgba_to_chw_tensor, viewport_to_student_tensor
from phishguard_ml_lifecycle.evaluator import ModelEvaluator
from phishguard_ml_lifecycle.export_pipeline import ModelExportPipeline
from phishguard_ml_lifecycle.training_pipeline import TrainingPipeline

FIXTURE = Path(__file__).resolve().parents[2] / "extension" / "tests" / "fixtures" / "viewport_8x8.json"


def test_rgba_to_chw_tensor_matches_extension_fixture():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    pixels = np.array(fixture["rgba"], dtype=np.uint8).reshape(fixture["height"], fixture["width"], 4)
    tensor = rgba_to_chw_tensor(pixels)

    assert tensor.shape == (3, fixture["height"], fixture["width"])
    assert tensor.dtype == np.float32
    assert 0.0 <= tensor.min() and tensor.max() <= 1.0
    np.testing.assert_allclose(tensor.reshape(-1), np.array(fixture["expected"], dtype=np.float32), atol=1e-6)


def test_viewport_to_student_tensor_shape_and_range():
    image = Image.new("RGB", (224, 224), color=(255, 0, 128))
    tensor = viewport_to_student_tensor(image)
    assert tensor.shape == (3, 64, 64)
    assert tensor.dtype == torch.float32
    assert torch.allclose(tensor[0], torch.ones(64, 64))
    assert torch.allclose(tensor[1], torch.zeros(64, 64))
    assert abs(float(tensor[2].mean()) - 128 / 255) < 1e-4


def test_visual_student_train_export_and_evaluate():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        pipeline = TrainingPipeline(checkpoint_manager=manager)
        config = {
            "include_visual": True,
            "behavioral_dim": 64,
            "hyperparameters": {"epochs": 2, "batch_size": 16, "learning_rate": 0.003},
        }

        result = pipeline.train_student(config=config, num_samples=64)
        assert result["epochs_completed"] == 2
        assert Path(result["best_checkpoint_path"]).exists()

        onnx_path = ModelExportPipeline(checkpoint_manager=manager).export_checkpoint(
            Path(result["best_checkpoint_path"]), version_label="9.9.9", include_visual=True
        )
        model = onnx.load(str(onnx_path))
        onnx.checker.check_model(model)
        assert [i.name for i in model.graph.input] == ["trajectory", "visual"]

        session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        out = session.run(
            None,
            {
                "trajectory": np.zeros((1, 128, 6), dtype=np.float32),
                "visual": np.zeros((1, 3, 64, 64), dtype=np.float32),
            },
        )[0]
        assert 0.0 <= float(np.asarray(out).reshape(-1)[0]) <= 1.0

        trained = DistilledStudentModel(behavioral_in_channels=6, behavioral_dim=64, include_visual=True)
        manager.load_checkpoint(Path(result["best_checkpoint_path"]), trained)
        report = ModelEvaluator().evaluate_visual_model(trained, test_samples=20, onnx_path=onnx_path)
        assert {"accuracy", "f1_score", "zero_visual_accuracy"} <= set(report.metrics)
        assert report.latency_ms_avg >= 0.0


def test_non_visual_training_is_unchanged():
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = CheckpointManager(base_dir=Path(tmpdir))
        result = TrainingPipeline(checkpoint_manager=manager).train_student(
            config={"behavioral_dim": 32, "hyperparameters": {"epochs": 1, "batch_size": 16}}, num_samples=32
        )
        assert result["epochs_completed"] == 1
        assert result["model"].include_visual is False

"""Integration test for training pipeline on stored multimodal dataset and SOTA benchmarks."""

from pathlib import Path
import tempfile
import pytest

from phishguard_ml_lifecycle import (
    TrainingPipeline,
    ModelEvaluator,
    CheckpointManager,
    PhishGuardSOTAMultimodalModel,
    SOTA_BENCHMARK_TARGETS,
)
from phishguard_types import SOTABenchmarkReport, DatasetManifest


def test_end_to_end_sota_training_pipeline():
    with tempfile.TemporaryDirectory() as tmpdir:
        data_dir = Path(tmpdir) / "sota_data"
        checkpoint_dir = Path(tmpdir) / "checkpoints"

        manager = CheckpointManager(base_dir=checkpoint_dir)
        pipeline = TrainingPipeline(checkpoint_manager=manager)

        # 1. Extract and store dataset to disk
        manifest = pipeline.extract_and_store_dataset(
            output_dir=data_dir,
            num_samples=40,
            split_ratios=(0.60, 0.20, 0.20),
            save_images=False,
            seed=42,
        )
        assert isinstance(manifest, DatasetManifest)
        assert manifest.totalSamples == 40

        # 2. Train SOTA Multimodal model on stored dataset
        train_res = pipeline.train_sota_multimodal(
            dataset_dir=data_dir,
            epochs=3,
            batch_size=8,
            lr=1e-3,
        )
        assert "model" in train_res
        assert "training_results" in train_res
        assert len(train_res["training_results"]["history"]) == 3
        assert Path(train_res["best_checkpoint_path"]).exists()

        # 3. Evaluate using ModelEvaluator against industry SOTA benchmarks
        evaluator = ModelEvaluator()
        report = evaluator.evaluate_sota_dataset(
            model=train_res["model"],
            dataset_dir=data_dir,
            split="test",
            batch_size=8,
        )

        assert isinstance(report, SOTABenchmarkReport)
        assert 0.0 <= report.accuracy <= 1.0
        assert 0.0 <= report.precision <= 1.0
        assert 0.0 <= report.recall <= 1.0
        assert 0.0 <= report.f1Score <= 1.0
        assert 0.0 <= report.falsePositiveRate <= 1.0
        assert 0.0 <= report.rocAuc <= 1.0
        assert 0.0 <= report.brierScore <= 1.0
        assert report.latencyMsAvg < 30.0


def test_cli_extract_dataset_and_train_sota(monkeypatch):
    from phishguard_ml_lifecycle import cli

    with tempfile.TemporaryDirectory() as tmpdir:
        data_dir = str(Path(tmpdir) / "cli_dataset")

        # 1. Test CLI extract-dataset
        monkeypatch.setattr(
            "sys.argv",
            ["phishguard-ml", "extract-dataset", "--output", data_dir, "--samples", "20", "--no-images"],
        )
        rc = cli.main()
        assert rc == 0
        assert (Path(data_dir) / "dataset_manifest.json").exists()

        # 2. Test CLI train with --dataset and --sota
        monkeypatch.setattr(
            "sys.argv",
            ["phishguard-ml", "train", "--dataset", data_dir, "--sota", "--epochs", "2"],
        )
        rc_train = cli.main()
        assert rc_train == 0


"""Unit tests for multimodal dataset extraction, storage, and loading."""

from pathlib import Path
import tempfile
import numpy as np
import pytest

from phishguard_ml_engine.data.multimodal_generator import generate_multimodal_dataset_batch
from phishguard_ml_lifecycle.dataset_storage import (
    store_multimodal_dataset,
    load_multimodal_dataset_split,
    load_multimodal_dataset_jsonl,
    load_dataset_manifest,
)
from phishguard_ml_lifecycle.dataset import SOTAMultimodalDataset, create_sota_multimodal_dataloader
from phishguard_types import DatasetManifest


def test_store_and_load_multimodal_dataset():
    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "test_dataset"

        # Generate 20 sample records
        samples = generate_multimodal_dataset_batch(num_samples=20, phishing_ratio=0.5, seed=42)

        # Store to disk
        manifest = store_multimodal_dataset(
            output_dir=out_dir,
            samples=samples,
            dataset_name="phishguard-test-data",
            dataset_version="1.0.0",
            split_ratios=(0.60, 0.20, 0.20),
            save_images=True,
        )

        assert isinstance(manifest, DatasetManifest)
        assert manifest.totalSamples == 20
        assert manifest.datasetName == "phishguard-test-data"
        assert len(manifest.splits) == 3
        split_counts = {
            split: manifest.splits[split].totalSamples
            for split in ("train", "val", "test")
        }
        assert sum(split_counts.values()) == len(samples)

        # Check directory layout on disk
        manifest_file = out_dir / "dataset_manifest.json"
        assert manifest_file.exists()

        for split_name in ["train", "val", "test"]:
            split_dir = out_dir / split_name
            assert split_dir.exists()
            assert (split_dir / "samples.jsonl").exists()
            assert (split_dir / "tensors.npz").exists()
            assert (split_dir / "screens").exists()
            assert (split_dir / "logos").exists()

        # Load tensors directly from disk
        tensors = load_multimodal_dataset_split(out_dir, split="train")
        assert "viewports" in tensors
        assert tensors["viewports"].shape == (split_counts["train"], 3, 224, 224)
        assert tensors["dynamics"].shape == (split_counts["train"], 5, 64)
        assert tensors["url_features"].shape == (split_counts["train"], 32)
        assert tensors["hid_features"].shape == (split_counts["train"], 16)
        assert tensors["logo_features"].shape == (split_counts["train"], 16)
        assert tensors["detection_features"].shape == (split_counts["train"], 16)
        assert tensors["labels"].shape == (split_counts["train"], 1)

        # Load JSONL records
        records = load_multimodal_dataset_jsonl(out_dir, split="train")
        assert len(records) == split_counts["train"]
        assert "url" in records[0]
        assert "sampleId" in records[0]

        # Load manifest directly
        loaded_m = load_dataset_manifest(out_dir)
        assert loaded_m.totalSamples == 20
        assert "url" in loaded_m.modalitiesSupported
        assert "logo" in loaded_m.modalitiesSupported

        # Test SOTAMultimodalDataset initialization from disk directory
        ds = SOTAMultimodalDataset(data_dir=out_dir, split="train", augment=True)
        assert len(ds) == split_counts["train"]
        vp, dyn, url, hid, logo, det, lbl = ds[0]
        assert vp.shape == (3, 224, 224)
        assert dyn.shape == (5, 64)
        assert url.shape == (32,)
        assert hid.shape == (16,)
        assert logo.shape == (16,)
        assert det.shape == (16,)
        assert lbl.shape == (1,)

        # Test DataLoader factory
        loader = create_sota_multimodal_dataloader(out_dir, split="train", batch_size=4)
        batch = next(iter(loader))
        assert len(batch) == 7
        assert batch[0].shape == (4, 3, 224, 224)  # batch of viewports
        assert batch[2].shape == (4, 32)           # batch of URL features
        assert batch[6].shape == (4, 1)            # batch of labels


def test_extract_and_store_industrial_benchmark():
    from phishguard_ml_lifecycle.training_pipeline import TrainingPipeline

    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "industrial_benchmark_dataset"
        pipeline = TrainingPipeline()
        manifest = pipeline.extract_and_store_dataset(
            output_dir=out_dir,
            num_samples=16,
            split_ratios=(0.5, 0.25, 0.25),
            save_images=False,
            seed=42,
            benchmark="industrial",
        )

        assert manifest.datasetName == "phishguard-industrial-benchmark"
        assert manifest.totalSamples == 16
        assert (out_dir / "dataset_manifest.json").exists()
        assert (out_dir / "train" / "tensors.npz").exists()
        assert (out_dir / "val" / "tensors.npz").exists()
        assert (out_dir / "test" / "tensors.npz").exists()

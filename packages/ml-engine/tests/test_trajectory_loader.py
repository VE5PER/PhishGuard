"""Unit tests for PyTorch Trajectory Dataset and Bézier Synthesizer."""

import pytest
import torch
from phishguard_ml_engine.data import (
    synthesize_human_trajectory_curve,
    generate_synthetic_trajectory,
    pad_or_resample_trajectory,
    TrajectoryDataset,
    create_trajectory_dataloader,
)


def test_bezier_synthesizer_generates_valid_points():
    pts = synthesize_human_trajectory_curve(
        start=(0.1, 0.2),
        end=(0.8, 0.9),
        num_steps=64,
        total_time_ms=600.0,
    )
    assert len(pts) == 64
    for p in pts:
        assert 0.0 <= p["x"] <= 1.0
        assert 0.0 <= p["y"] <= 1.0
        assert p["velocity"] >= 0.0
        assert -3.15 <= p["angle"] <= 3.15


def test_pad_or_resample_trajectory_shape():
    raw_pts = generate_synthetic_trajectory(is_phishing=False, num_steps=42)
    resampled = pad_or_resample_trajectory(raw_pts, target_length=128)
    assert resampled.shape == (128, 6)
    # Check no NaN or infinite values
    assert not torch.isnan(torch.from_numpy(resampled)).any()
    assert not torch.isinf(torch.from_numpy(resampled)).any()


def test_trajectory_dataset_and_dataloader():
    samples = [
        generate_synthetic_trajectory(is_phishing=(i % 2 == 1), num_steps=50 + i * 10)
        for i in range(16)
    ]
    labels = [i % 2 for i in range(16)]

    dataset = TrajectoryDataset(samples, labels, seq_length=128)
    assert len(dataset) == 16

    item_traj, item_label = dataset[0]
    assert item_traj.shape == (128, 6)
    assert item_label.shape == (1,)

    loader = create_trajectory_dataloader(samples, labels, batch_size=4, shuffle=False)
    batch_trajs, batch_labels = next(iter(loader))
    assert batch_trajs.shape == (4, 128, 6)
    assert batch_labels.shape == (4, 1)

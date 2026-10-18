"""Paired (trajectory, 64x64 viewport, label) data for the on-device visual student."""

import random
from typing import List, Optional, Tuple

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset

from phishguard_ml_engine.data.bezier_synthesizer import generate_synthetic_trajectory
from phishguard_ml_engine.data.multimodal_generator import BRAND_LIST, _render_synthetic_viewport
from phishguard_ml_engine.data.trajectory_dataset import pad_or_resample_trajectory

from .dataset import STUDENT_VISUAL_SIZE, viewport_to_student_tensor


def build_visual_student_tensors(
    num_samples: int,
    seq_length: int = 128,
    seed: Optional[int] = None,
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Return trajectories (N, T, 6), viewports (N, 3, 64, 64) and labels (N, 1), balanced across classes."""
    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    trajectories: List[np.ndarray] = []
    viewports: List[torch.Tensor] = []
    labels: List[float] = []

    for i in range(num_samples):
        is_phishing = i % 2 == 1
        points = generate_synthetic_trajectory(is_phishing=is_phishing, num_steps=seq_length)
        trajectories.append(pad_or_resample_trajectory(points, target_length=seq_length))

        brand = random.choice(BRAND_LIST) if is_phishing else None
        image = _render_synthetic_viewport(is_phishing=is_phishing, brand_name=brand, target_size=(224, 224))
        viewports.append(viewport_to_student_tensor(image))
        labels.append(1.0 if is_phishing else 0.0)

    return (
        torch.from_numpy(np.stack(trajectories)).float(),
        torch.stack(viewports).float(),
        torch.tensor(labels, dtype=torch.float32).unsqueeze(1),
    )


class VisualStudentDataset(Dataset):
    """Dataset yielding (trajectory, visual, label)."""

    def __init__(self, trajectories: torch.Tensor, viewports: torch.Tensor, labels: torch.Tensor):
        assert viewports.shape[1:] == (3, STUDENT_VISUAL_SIZE, STUDENT_VISUAL_SIZE)
        self.trajectories = trajectories
        self.viewports = viewports
        self.labels = labels

    def __len__(self) -> int:
        return self.trajectories.shape[0]

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        return self.trajectories[idx], self.viewports[idx], self.labels[idx]


def create_visual_student_loaders(
    num_samples: int,
    seq_length: int = 128,
    batch_size: int = 32,
    split_ratio: float = 0.8,
    seed: Optional[int] = 0,
) -> Tuple[DataLoader, DataLoader]:
    trajs, viewports, labels = build_visual_student_tensors(num_samples, seq_length=seq_length, seed=seed)
    order = torch.randperm(num_samples, generator=torch.Generator().manual_seed(seed or 0))
    split = int(num_samples * split_ratio)
    train_idx, val_idx = order[:split], order[split:]
    train = VisualStudentDataset(trajs[train_idx], viewports[train_idx], labels[train_idx])
    val = VisualStudentDataset(trajs[val_idx], viewports[val_idx], labels[val_idx])
    return (
        DataLoader(train, batch_size=batch_size, shuffle=True, drop_last=False),
        DataLoader(val, batch_size=batch_size, shuffle=False, drop_last=False),
    )

"""PyTorch Trajectory Dataset and Resampling Pipeline.

Normalizes viewport coordinates to [0, 1] and resamples mouse trajectory sequences
to fixed length T = 128 with 6 kinematic channels: [x, y, dx, dy, v, theta].
"""

from typing import List, Dict, Any, Optional, Tuple
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader


def pad_or_resample_trajectory(
    points: List[Dict[str, Any]],
    target_length: int = 128,
) -> np.ndarray:
    """Resample or pad a variable-length list of pointer points to shape (target_length, 6).

    Channels:
        0: normalized x [0, 1]
        1: normalized y [0, 1]
        2: dx (delta x)
        3: dy (delta y)
        4: instantaneous velocity v
        5: angle theta in radians [-pi, pi]
    """
    if not points:
        return np.zeros((target_length, 6), dtype=np.float32)

    raw_features = []
    for p in points:
        raw_features.append([
            float(p.get("x", 0.0)),
            float(p.get("y", 0.0)),
            float(p.get("dx", 0.0)),
            float(p.get("dy", 0.0)),
            float(p.get("velocity", 0.0)),
            float(p.get("angle", 0.0)),
        ])

    raw_arr = np.array(raw_features, dtype=np.float32)
    n_pts = len(raw_arr)

    if n_pts == target_length:
        return raw_arr

    if n_pts == 1:
        return np.tile(raw_arr, (target_length, 1))

    # Interpolate across normalized index domain [0, 1]
    orig_steps = np.linspace(0.0, 1.0, num=n_pts)
    target_steps = np.linspace(0.0, 1.0, num=target_length)

    resampled = np.zeros((target_length, 6), dtype=np.float32)
    for col in range(6):
        resampled[:, col] = np.interp(target_steps, orig_steps, raw_arr[:, col])

    return resampled


class TrajectoryDataset(Dataset):
    """PyTorch Dataset for mouse trajectory sequences."""

    def __init__(
        self,
        samples: List[List[Dict[str, Any]]],
        labels: Optional[List[int]] = None,
        seq_length: int = 128,
    ):
        """
        Args:
            samples: List of variable-length trajectory point sequences.
            labels: Binary labels (0 for benign, 1 for phishing).
            seq_length: Fixed sequence length T (default: 128).
        """
        self.seq_length = seq_length
        self.trajectories = [
            pad_or_resample_trajectory(pts, target_length=seq_length)
            for pts in samples
        ]
        self.labels = labels

    def __len__(self) -> int:
        return len(self.trajectories)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, ...]:
        traj_tensor = torch.from_numpy(self.trajectories[idx]).float()  # (128, 6)

        if self.labels is not None:
            label_tensor = torch.tensor(self.labels[idx], dtype=torch.float32).unsqueeze(0)
            return traj_tensor, label_tensor

        return (traj_tensor,)


def create_trajectory_dataloader(
    samples: List[List[Dict[str, Any]]],
    labels: Optional[List[int]] = None,
    batch_size: int = 32,
    shuffle: bool = True,
    seq_length: int = 128,
) -> DataLoader:
    """Convenience factory creating a standard PyTorch DataLoader."""
    dataset = TrajectoryDataset(samples, labels, seq_length=seq_length)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        drop_last=False,
    )

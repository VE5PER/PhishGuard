"""Tensor contracts, preprocessing, and multimodal dataset for PhishGuard Unified Model."""

import math
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader

# ImageNet normalization constants
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)

# Event type mapping
EVENT_TYPE_MAP = {
    "move": 0.0,
    "hover": 0.33,
    "click": 0.66,
    "paste": 1.0,
    "down": 0.66,
    "up": 0.0,
}


def normalize_viewport_image(
    image: Union[np.ndarray, torch.Tensor],
    target_size: Tuple[int, int] = (224, 224),
) -> torch.Tensor:
    """Center-crop / resize and normalize viewport image to (3, 224, 224) using ImageNet stats.

    Args:
        image: Array of shape (H, W, 3) with values in [0, 255] or (3, H, W) in [0, 1].
        target_size: Output (height, width), default (224, 224).

    Returns:
        Tensor of shape (3, 224, 224) normalized by ImageNet mean and std.
    """
    if isinstance(image, torch.Tensor):
        img_np = image.detach().cpu().numpy()
    else:
        img_np = np.array(image, dtype=np.float32)

    # Convert (H, W, 3) to (3, H, W) if needed
    if img_np.ndim == 3 and img_np.shape[2] == 3:
        img_np = np.transpose(img_np, (2, 0, 1))

    # Scale to [0, 1] if in [0, 255]
    if img_np.max() > 1.5:
        img_np = img_np / 255.0

    _, h, w = img_np.shape
    th, tw = target_size

    # Center crop / resize to target size
    if h != th or w != tw:
        # Center crop if larger, pad if smaller
        crop_top = max(0, (h - th) // 2)
        crop_left = max(0, (w - tw) // 2)
        cropped = img_np[:, crop_top : crop_top + th, crop_left : crop_left + tw]

        # In case dimensions are still smaller than target
        _, ch_h, ch_w = cropped.shape
        if ch_h < th or ch_w < tw:
            padded = np.zeros((3, th, tw), dtype=np.float32)
            padded[:, :ch_h, :ch_w] = cropped
            img_np = padded
        else:
            img_np = cropped

    # Normalize with ImageNet mean and std
    norm_img = (img_np - IMAGENET_MEAN) / IMAGENET_STD
    return torch.from_numpy(norm_img.astype(np.float32))


STUDENT_VISUAL_SIZE = 64


def rgba_to_chw_tensor(pixels: np.ndarray) -> np.ndarray:
    """Canonical on-device student pixel conversion (no resize).

    Input is an (H, W, 3|4) uint8 RGB(A) array. Output is a (3, H, W) float32 array,
    channel order RGB, values in [0, 1], without mean/std normalization. The alpha
    channel is ignored. The browser extension implements the identical conversion
    in `rgbaToChwTensor` (apps/extension/src/background/vision-capture.ts).
    """
    arr = np.asarray(pixels, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"Expected (H, W, 3|4) pixel array, got shape {arr.shape}")
    rgb = arr[:, :, :3].astype(np.float32) / 255.0
    return np.ascontiguousarray(np.transpose(rgb, (2, 0, 1)))


def viewport_to_student_tensor(image: Any) -> torch.Tensor:
    """Canonical student visual preprocessing: RGB, bilinear resize to 64x64, CHW float32 in [0, 1]."""
    from PIL import Image

    if isinstance(image, np.ndarray):
        pil = Image.fromarray(np.clip(image, 0, 255).astype(np.uint8)).convert("RGB")
    else:
        pil = image.convert("RGB")
    resized = pil.resize((STUDENT_VISUAL_SIZE, STUDENT_VISUAL_SIZE), Image.BILINEAR)
    return torch.from_numpy(rgba_to_chw_tensor(np.array(resized, dtype=np.uint8)))


def apply_visual_augmentations(img_tensor: torch.Tensor) -> torch.Tensor:
    """Apply visual augmentations: color jitter (+-10%), horizontal crop shift, and cutout/erasing."""
    augmented = img_tensor.clone()

    # 1. Color jitter (+-10%) on brightness / contrast
    jitter_factor = random.uniform(0.9, 1.1)
    augmented = augmented * jitter_factor

    # 2. Horizontal crop shift (+-8 pixels)
    shift = random.randint(-8, 8)
    if shift != 0:
        augmented = torch.roll(augmented, shifts=shift, dims=-1)

    # 3. Cutout / random erasing for logo robustness (16x16 to 32x32 patch)
    if random.random() < 0.5:
        _, h, w = augmented.shape
        cut_h = random.randint(16, 32)
        cut_w = random.randint(16, 32)
        y0 = random.randint(0, max(0, h - cut_h))
        x0 = random.randint(0, max(0, w - cut_w))
        augmented[:, y0 : y0 + cut_h, x0 : x0 + cut_w] = 0.0

    return augmented


def preprocess_interaction_sequence(
    events: List[Dict[str, Any]],
    seq_length: int = 64,
) -> torch.Tensor:
    """Preprocess cursor interactions into normalized 5-channel tensor of shape (5, 64).

    Channels per timestep t:
      0: x_t in [0, 1]
      1: y_t in [0, 1]
      2: v_t in [0, 1] (instantaneous velocity min-max scaled)
      3: delta_theta_t in [-1, 1] (angular change (theta_t - theta_{t-1}) / pi)
      4: e_t in {0.0, 0.33, 0.66, 1.0} (scalar-mapped event type)

    Returns:
        Tensor of shape (5, seq_length). Missing / short sequences are zero-padded.
    """
    matrix = np.zeros((5, seq_length), dtype=np.float32)
    if not events:
        return torch.from_numpy(matrix)

    # Take most recent seq_length events
    recent_events = events[-seq_length:]
    num_events = len(recent_events)

    prev_angle = 0.0
    raw_velocities = []

    # First pass: compute velocities to determine scaling
    for i in range(num_events):
        ev = recent_events[i]
        vel = float(ev.get("velocity", 0.0))
        if vel == 0.0 and i > 0:
            dx = float(ev.get("dx", 0.0))
            dy = float(ev.get("dy", 0.0))
            dt = float(ev.get("dt", 16.67))
            vel = math.hypot(dx, dy) / max(dt, 1e-4)
        raw_velocities.append(vel)

    max_v = max(max(raw_velocities) if raw_velocities else 1.0, 1e-5)

    # Fill matrix at the end of the sequence (right-aligned, zero-padded on the left)
    start_col = seq_length - num_events
    for idx, ev in enumerate(recent_events):
        col = start_col + idx
        # Channel 0: x in [0, 1]
        x_val = min(max(float(ev.get("x", 0.0)), 0.0), 1.0)
        # Channel 1: y in [0, 1]
        y_val = min(max(float(ev.get("y", 0.0)), 0.0), 1.0)
        # Channel 2: v in [0, 1]
        v_val = min(max(raw_velocities[idx] / max_v, 0.0), 1.0)

        # Channel 3: delta_theta in [-1, 1]
        curr_angle = float(ev.get("angle", 0.0))
        angle_diff = (curr_angle - prev_angle) / math.pi
        # Wrap to [-1, 1]
        while angle_diff > 1.0:
            angle_diff -= 2.0
        while angle_diff < -1.0:
            angle_diff += 2.0
        prev_angle = curr_angle

        # Channel 4: event type in {0.0, 0.33, 0.66, 1.0}
        ev_type_str = str(ev.get("eventType", ev.get("type", "move"))).lower()
        ev_type_val = EVENT_TYPE_MAP.get(ev_type_str, 0.0)

        matrix[0, col] = x_val
        matrix[1, col] = y_val
        matrix[2, col] = v_val
        matrix[3, col] = angle_diff
        matrix[4, col] = ev_type_val

    return torch.from_numpy(matrix)


def apply_dynamics_augmentations(dyn_tensor: torch.Tensor) -> torch.Tensor:
    """Apply Gaussian temporal jitter (sigma=0.02) and random trajectory truncation."""
    augmented = dyn_tensor.clone()

    # 1. Gaussian temporal jitter on spatial and velocity channels [0, 1, 2]
    jitter = torch.randn_like(augmented[:3, :]) * 0.02
    augmented[:3, :] = torch.clamp(augmented[:3, :] + jitter, 0.0, 1.0)

    # 2. Random trajectory truncation (zero out early timesteps up to 25% of sequence)
    if random.random() < 0.3:
        trunc_len = random.randint(4, 16)
        augmented[:, :trunc_len] = 0.0

    return augmented


class PhishGuardMultimodalDataset(Dataset):
    """Synchronized Multimodal Dataset for PhishGuard Unified Model."""

    def __init__(
        self,
        samples: List[Dict[str, Any]],
        augment: bool = False,
        seq_length: int = 64,
        target_image_size: Tuple[int, int] = (224, 224),
    ):
        self.samples = samples
        self.augment = augment
        self.seq_length = seq_length
        self.target_image_size = target_image_size

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        sample = self.samples[idx]

        # 1. Visual Stream
        raw_image = sample.get("viewport")
        if raw_image is None:
            # Generate representative neutral synthetic viewport if missing
            raw_image = np.ones((self.target_image_size[0], self.target_image_size[1], 3), dtype=np.float32) * 0.9
        viewport_tensor = normalize_viewport_image(raw_image, target_size=self.target_image_size)
        if self.augment:
            viewport_tensor = apply_visual_augmentations(viewport_tensor)

        # 2. Kinematic Dynamics Stream
        raw_events = sample.get("dynamics", [])
        if isinstance(raw_events, torch.Tensor):
            dynamics_tensor = raw_events
        else:
            dynamics_tensor = preprocess_interaction_sequence(raw_events, seq_length=self.seq_length)
        if self.augment:
            dynamics_tensor = apply_dynamics_augmentations(dynamics_tensor)

        # 3. Label
        label = float(sample.get("label", 0.0))
        label_tensor = torch.tensor([label], dtype=torch.float32)

        return viewport_tensor, dynamics_tensor, label_tensor


def create_multimodal_dataloader(
    samples: List[Dict[str, Any]],
    batch_size: int = 16,
    shuffle: bool = True,
    augment: bool = False,
    num_workers: int = 0,
) -> DataLoader:
    """Create PyTorch DataLoader for synchronized multimodal training."""
    dataset = PhishGuardMultimodalDataset(samples=samples, augment=augment)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        drop_last=False,
    )


class SOTAMultimodalDataset(Dataset):
    """Industry SOTA Multimodal Dataset supporting all 5 streams: URL, HID, Logo, Screen, Detection."""

    def __init__(
        self,
        samples: Optional[List[Dict[str, Any]]] = None,
        data_dir: Optional[Union[str, Path]] = None,
        split: str = "train",
        augment: bool = False,
        seq_length: int = 64,
        target_image_size: Tuple[int, int] = (224, 224),
    ):
        self.augment = augment
        self.seq_length = seq_length
        self.target_image_size = target_image_size
        self.from_npz = False

        if data_dir is not None:
            npz_path = Path(data_dir) / split / "tensors.npz"
            if npz_path.exists():
                data = np.load(npz_path)
                self.viewports = data["viewports"]
                self.dynamics = data["dynamics"]
                self.url_features = data["url_features"]
                self.hid_features = data["hid_features"]
                self.logo_features = data["logo_features"]
                self.detection_features = data["detection_features"]
                self.labels = data["labels"]
                self.length = len(self.labels)
                self.from_npz = True
            else:
                raise FileNotFoundError(f"Tensors archive not found at {npz_path}")
        elif samples is not None:
            self.samples = samples
            self.length = len(samples)
        else:
            raise ValueError("Either samples or data_dir must be provided to SOTAMultimodalDataset")

    def __len__(self) -> int:
        return self.length

    def __getitem__(
        self, idx: int
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        if self.from_npz:
            vp = torch.from_numpy(self.viewports[idx]).float()
            dyn = torch.from_numpy(self.dynamics[idx]).float()
            url = torch.from_numpy(self.url_features[idx]).float()
            hid = torch.from_numpy(self.hid_features[idx]).float()
            logo = torch.from_numpy(self.logo_features[idx]).float()
            det = torch.from_numpy(self.detection_features[idx]).float()
            lbl = torch.from_numpy(self.labels[idx]).float()
        else:
            sample = self.samples[idx]

            # 1. Viewport image
            raw_image = sample.get("viewport")
            if raw_image is None:
                raw_image = np.ones((self.target_image_size[0], self.target_image_size[1], 3), dtype=np.float32) * 0.9
            vp = normalize_viewport_image(raw_image, target_size=self.target_image_size)

            # 2. Kinematic dynamics
            raw_events = sample.get("pointerSeries") or sample.get("dynamics", [])
            if isinstance(raw_events, torch.Tensor):
                dyn = raw_events
            else:
                dyn = preprocess_interaction_sequence(raw_events, seq_length=self.seq_length)

            # 3. Features
            ext = sample.get("extractedFeatures", {})
            url_list = ext.get("url") or [0.0] * 32
            hid_list = ext.get("hid") or [0.0] * 16
            logo_list = ext.get("logo") or [0.0] * 16
            det_list = ext.get("detection") or [0.0] * 16

            url = torch.tensor(url_list, dtype=torch.float32)
            hid = torch.tensor(hid_list, dtype=torch.float32)
            logo = torch.tensor(logo_list, dtype=torch.float32)
            det = torch.tensor(det_list, dtype=torch.float32)

            # 4. Label
            lbl = torch.tensor([float(sample.get("label", 0.0))], dtype=torch.float32)

        if self.augment:
            vp = apply_visual_augmentations(vp)
            dyn = apply_dynamics_augmentations(dyn)
            # Subtle feature jitter on tabular streams
            url = torch.clamp(url + torch.randn_like(url) * 0.01, 0.0, 1.0)
            hid = torch.clamp(hid + torch.randn_like(hid) * 0.01, 0.0, 1.0)

        return vp, dyn, url, hid, logo, det, lbl


def create_sota_multimodal_dataloader(
    samples_or_dir: Union[List[Dict[str, Any]], str, Path],
    split: str = "train",
    batch_size: int = 16,
    shuffle: bool = True,
    augment: bool = False,
    num_workers: int = 0,
) -> DataLoader:
    """Create PyTorch DataLoader for SOTA 5-stream multimodal dataset."""
    if isinstance(samples_or_dir, (str, Path)):
        dataset = SOTAMultimodalDataset(data_dir=samples_or_dir, split=split, augment=augment)
    else:
        dataset = SOTAMultimodalDataset(samples=samples_or_dir, augment=augment)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        drop_last=False,
    )


"""Storage, serialization, and disk extraction pipeline for PhishGuard multimodal datasets."""

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
from PIL import Image

from phishguard_types import DatasetManifest, DatasetSplitStats
from .dataset import normalize_viewport_image, preprocess_interaction_sequence
from .group_splitting import split_grouped_samples


SOTA_BENCHMARK_TARGETS = {
    "min_accuracy": 0.985,
    "min_precision": 0.985,
    "min_recall": 0.980,
    "min_f1": 0.982,
    "max_fpr": 0.005,
    "min_roc_auc": 0.990,
    "max_brier": 0.050,
    "max_latency_ms": 30.0,
}

FEATURE_DIMENSIONS = {
    "url": 32,
    "hid": 16,
    "logo": 16,
    "detection": 16,
    "dynamics_channels": 5,
    "dynamics_steps": 64,
    "viewport_c": 3,
    "viewport_h": 224,
    "viewport_w": 224,
}


def store_multimodal_dataset(
    output_dir: Union[str, Path],
    samples: List[Dict[str, Any]],
    dataset_name: str = "phishguard-multimodal-sota",
    dataset_version: str = "1.0.0",
    split_ratios: Tuple[float, float, float] = (0.70, 0.15, 0.15),
    save_images: bool = True,
    seq_length: int = 64,
) -> DatasetManifest:
    """Extract and store multimodal dataset to disk with structured train/val/test splits.

    Directory Layout:
      <output_dir>/
      ├── dataset_manifest.json
      ├── train/
      │   ├── samples.jsonl
      │   ├── tensors.npz
      │   ├── screens/*.png
      │   └── logos/*.png
      ├── val/
      │   └── ...
      └── test/
          └── ...
    """
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    n_total = len(samples)
    splits = split_grouped_samples(samples, split_ratios)

    split_stats_dict: Dict[str, DatasetSplitStats] = {}

    for split_name, split_list in splits.items():
        split_dir = out_path / split_name
        split_dir.mkdir(parents=True, exist_ok=True)
        screens_dir = split_dir / "screens"
        logos_dir = split_dir / "logos"
        if save_images:
            screens_dir.mkdir(exist_ok=True)
            logos_dir.mkdir(exist_ok=True)

        jsonl_path = split_dir / "samples.jsonl"
        npz_path = split_dir / "tensors.npz"

        # Pre-allocate numpy arrays for fast batch training
        n_split = len(split_list)
        viewports_arr = np.zeros((n_split, 3, 224, 224), dtype=np.float32)
        dynamics_arr = np.zeros((n_split, 5, seq_length), dtype=np.float32)
        url_features_arr = np.zeros((n_split, 32), dtype=np.float32)
        hid_features_arr = np.zeros((n_split, 16), dtype=np.float32)
        logo_features_arr = np.zeros((n_split, 16), dtype=np.float32)
        detection_features_arr = np.zeros((n_split, 16), dtype=np.float32)
        labels_arr = np.zeros((n_split, 1), dtype=np.float32)

        phish_count = 0
        benign_count = 0
        logo_count = 0
        screen_count = 0

        with open(jsonl_path, "w", encoding="utf-8") as f_jsonl:
            for idx, s in enumerate(split_list):
                lbl = float(s.get("label", 0.0))
                labels_arr[idx, 0] = lbl
                if lbl >= 0.5:
                    phish_count += 1
                else:
                    benign_count += 1

                sid = str(s.get("sampleId", idx))

                # 1. Viewport image processing
                raw_img = s.get("viewport")
                pil_img = s.get("viewport_pil")
                if raw_img is not None:
                    vp_tensor = normalize_viewport_image(raw_img, target_size=(224, 224))
                    viewports_arr[idx] = vp_tensor.numpy()
                    screen_count += 1
                elif pil_img is not None:
                    vp_tensor = normalize_viewport_image(np.array(pil_img, dtype=np.float32), target_size=(224, 224))
                    viewports_arr[idx] = vp_tensor.numpy()
                    screen_count += 1

                if save_images and pil_img is not None:
                    img_path = screens_dir / f"{sid}.png"
                    pil_img.save(img_path, format="PNG")

                # 2. Dynamics processing
                raw_events = s.get("pointerSeries") or s.get("dynamics") or []
                dyn_tensor = preprocess_interaction_sequence(raw_events, seq_length=seq_length)
                dynamics_arr[idx] = dyn_tensor.numpy()

                # 3. Features extraction
                ext_feat = s.get("extractedFeatures", {})
                url_f = ext_feat.get("url")
                hid_f = ext_feat.get("hid")
                logo_f = ext_feat.get("logo")
                det_f = ext_feat.get("detection")

                if url_f is not None:
                    url_features_arr[idx] = np.array(url_f, dtype=np.float32)
                if hid_f is not None:
                    hid_features_arr[idx] = np.array(hid_f, dtype=np.float32)
                if logo_f is not None:
                    logo_features_arr[idx] = np.array(logo_f, dtype=np.float32)
                if det_f is not None:
                    detection_features_arr[idx] = np.array(det_f, dtype=np.float32)

                logo_dets = s.get("logoDetections", [])
                if logo_dets:
                    logo_count += 1

                # Clean record for JSONL (omit bulky numpy arrays from JSON)
                json_record = {
                    "sampleId": sid,
                    "label": lbl,
                    "url": s.get("url", ""),
                    "domain": s.get("domain", ""),
                    "targetBrand": s.get("targetBrand"),
                    "pointerSeries": s.get("pointerSeries", []),
                    "keystrokes": s.get("keystrokes", []),
                    "domEvents": s.get("domEvents", []),
                    "logoDetections": s.get("logoDetections", []),
                    "imageDetections": s.get("imageDetections", []),
                    "extractedFeatures": {
                        "url": url_features_arr[idx].tolist(),
                        "hid": hid_features_arr[idx].tolist(),
                        "logo": logo_features_arr[idx].tolist(),
                        "detection": detection_features_arr[idx].tolist(),
                    },
                    "createdAt": s.get("createdAt", datetime.now(timezone.utc).isoformat()),
                    "provenance": s.get("provenance"),
                }
                f_jsonl.write(json.dumps(json_record) + "\n")

        # Save fast binary tensors
        np.savez_compressed(
            npz_path,
            viewports=viewports_arr,
            dynamics=dynamics_arr,
            url_features=url_features_arr,
            hid_features=hid_features_arr,
            logo_features=logo_features_arr,
            detection_features=detection_features_arr,
            labels=labels_arr,
        )

        split_stats_dict[split_name] = DatasetSplitStats(
            totalSamples=n_split,
            phishingSamples=phish_count,
            benignSamples=benign_count,
            samplesWithLogo=logo_count,
            samplesWithScreenshot=screen_count,
        )

    # Build and persist dataset manifest
    manifest = DatasetManifest(
        datasetName=dataset_name,
        datasetVersion=dataset_version,
        createdAt=datetime.now(timezone.utc).isoformat(),
        totalSamples=n_total,
        splits=split_stats_dict,
        modalitiesSupported=["url", "hid_input", "logo", "screen", "image_detection"],
        sotaBenchmarkTargets=SOTA_BENCHMARK_TARGETS,
        featureDimensions=FEATURE_DIMENSIONS,
    )

    manifest_path = out_path / "dataset_manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f_m:
        json.dump(manifest.model_dump(), f_m, indent=2)

    return manifest


def load_multimodal_dataset_split(
    dataset_dir: Union[str, Path],
    split: str = "train",
) -> Dict[str, np.ndarray]:
    """Load pre-processed NumPy tensors for a specific dataset split."""
    npz_path = Path(dataset_dir) / split / "tensors.npz"
    if not npz_path.exists():
        raise FileNotFoundError(f"Tensors archive not found at: {npz_path}")
    data = np.load(npz_path)
    return {
        "viewports": data["viewports"],
        "dynamics": data["dynamics"],
        "url_features": data["url_features"],
        "hid_features": data["hid_features"],
        "logo_features": data["logo_features"],
        "detection_features": data["detection_features"],
        "labels": data["labels"],
    }


def load_multimodal_dataset_jsonl(
    dataset_dir: Union[str, Path],
    split: str = "train",
) -> List[Dict[str, Any]]:
    """Load JSONL sample records for a specific dataset split."""
    jsonl_path = Path(dataset_dir) / split / "samples.jsonl"
    if not jsonl_path.exists():
        raise FileNotFoundError(f"JSONL samples not found at: {jsonl_path}")
    records = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_dataset_manifest(dataset_dir: Union[str, Path]) -> DatasetManifest:
    """Load dataset manifest from disk."""
    m_path = Path(dataset_dir) / "dataset_manifest.json"
    if not m_path.exists():
        raise FileNotFoundError(f"Manifest not found at: {m_path}")
    with open(m_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return DatasetManifest.model_validate(data)

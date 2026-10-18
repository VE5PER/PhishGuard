"""Data engineering and dataset modules."""

from .bezier_synthesizer import generate_synthetic_trajectory, synthesize_human_trajectory_curve
from .trajectory_dataset import TrajectoryDataset, pad_or_resample_trajectory, create_trajectory_dataloader
from .feature_extractor import (
    extract_url_features,
    extract_hid_features,
    extract_logo_features,
    extract_image_detection_features,
    is_official_domain_for_brand,
    BRAND_LIST,
    BRAND_LEGITIMATE_DOMAINS,
)
from .multimodal_generator import (
    generate_multimodal_sample,
    generate_multimodal_dataset_batch,
)
from .industrial_benchmark_dataset import build_industrial_benchmark_dataset

__all__ = [
    "generate_synthetic_trajectory",
    "synthesize_human_trajectory_curve",
    "TrajectoryDataset",
    "pad_or_resample_trajectory",
    "create_trajectory_dataloader",
    "extract_url_features",
    "extract_hid_features",
    "extract_logo_features",
    "extract_image_detection_features",
    "is_official_domain_for_brand",
    "BRAND_LIST",
    "BRAND_LEGITIMATE_DOMAINS",
    "generate_multimodal_sample",
    "generate_multimodal_dataset_batch",
    "build_industrial_benchmark_dataset",
]

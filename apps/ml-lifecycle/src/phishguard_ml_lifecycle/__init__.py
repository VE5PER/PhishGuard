"""PhishGuard ML Lifecycle, Checkpoint Management & Deployment Package."""

from .checkpoint_manager import CheckpointManager, CheckpointMetadata, compute_file_sha256
from .training_pipeline import TrainingPipeline
from .evaluator import ModelEvaluator, EvaluationReport
from .export_pipeline import ModelExportPipeline
from .promotion import ModelPromoter, PromotionResult

# Unified Ultra-Lightweight ML Architecture & Lifecycle
from .unified_model import (
    PhishGuardUnifiedModel,
    PhishGuardSOTAMultimodalModel,
    MobileNetV4ConvSmall050,
    KinematicDynamicsBackbone,
)
from .dataset import (
    PhishGuardMultimodalDataset,
    SOTAMultimodalDataset,
    normalize_viewport_image,
    preprocess_interaction_sequence,
    create_multimodal_dataloader,
    create_sota_multimodal_dataloader,
    apply_visual_augmentations,
    apply_dynamics_augmentations,
)
from .dataset_storage import (
    store_multimodal_dataset,
    load_multimodal_dataset_split,
    load_multimodal_dataset_jsonl,
    load_dataset_manifest,
    SOTA_BENCHMARK_TARGETS,
    FEATURE_DIMENSIONS,
)
from .losses import (
    FocalBrierCalibrationLoss,
    build_warmup_cosine_scheduler,
)
from .unified_training import (
    train_unified_model,
    train_unified_epoch,
    evaluate_unified_epoch,
)
from .quantize_export import (
    SessionCalibrationDataReader,
    export_static_onnx,
    quantize_model_int8,
    verify_onnx_divergence,
)

__all__ = [
    # Legacy & Registry
    "CheckpointManager",
    "CheckpointMetadata",
    "compute_file_sha256",
    "TrainingPipeline",
    "ModelEvaluator",
    "EvaluationReport",
    "ModelExportPipeline",
    "ModelPromoter",
    "PromotionResult",
    # Unified Model & Architecture
    "PhishGuardUnifiedModel",
    "PhishGuardSOTAMultimodalModel",
    "MobileNetV4ConvSmall050",
    "KinematicDynamicsBackbone",
    # Preprocessing & Data Contracts
    "PhishGuardMultimodalDataset",
    "SOTAMultimodalDataset",
    "normalize_viewport_image",
    "preprocess_interaction_sequence",
    "create_multimodal_dataloader",
    "create_sota_multimodal_dataloader",
    "apply_visual_augmentations",
    "apply_dynamics_augmentations",
    # Storage & Serialization
    "store_multimodal_dataset",
    "load_multimodal_dataset_split",
    "load_multimodal_dataset_jsonl",
    "load_dataset_manifest",
    "SOTA_BENCHMARK_TARGETS",
    "FEATURE_DIMENSIONS",
    # Losses & Optimization
    "FocalBrierCalibrationLoss",
    "build_warmup_cosine_scheduler",
    "train_unified_model",
    "train_unified_epoch",
    "evaluate_unified_epoch",
    # Deployment, Export & INT8 PTQ
    "SessionCalibrationDataReader",
    "export_static_onnx",
    "quantize_model_int8",
    "verify_onnx_divergence",
]

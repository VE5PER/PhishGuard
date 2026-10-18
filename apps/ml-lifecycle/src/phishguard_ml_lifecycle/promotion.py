"""Promotion workflow for registering and distributing production-ready models."""

from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from phishguard_types import ModelMetrics, ModelMetadata

from .checkpoint_manager import CheckpointManager, compute_file_sha256
from .release_validation import validate_context_release


class PromotionResult(BaseModel):
    """Result of a model promotion operation."""

    version: str
    sha256: str
    file_size_bytes: int
    registry_path: str
    backend_model_path: Optional[str] = None
    extension_model_path: Optional[str] = None
    promoted_at: str
    success: bool


class ModelPromoter:
    """Promotes validated checkpoints to official versioned releases across apps."""

    def __init__(
        self,
        checkpoint_manager: Optional[CheckpointManager] = None,
        project_root: Optional[Path] = None,
    ):
        self.checkpoint_manager = checkpoint_manager or CheckpointManager()
        if project_root is None:
            # apps/ml-lifecycle -> apps -> root
            self.project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
        else:
            self.project_root = Path(project_root).resolve()

        self.backend_models_dir = self.project_root / "apps" / "backend" / "models"
        self.extension_models_dir = self.project_root / "apps" / "extension" / "public" / "models"

    def promote_to_registry(
        self,
        onnx_source_path: Path,
        version: str,
        name: str,
        architecture: str,
        metrics: Dict[str, float],
        changelog: List[str],
        min_extension_version: str = "0.1.0",
        sync_to_backend: bool = True,
        sync_to_extension: bool = True,
        evaluation_report: Optional[Path] = None,
        corpus_manifest: Optional[Path] = None,
        runtime_evidence: Optional[Path] = None,
        replace_extension_bundle: bool = False,
    ) -> PromotionResult:
        """Promote an ONNX candidate into the release registry and synchronize to app consumers."""
        src_path = Path(onnx_source_path)
        if not src_path.exists():
            raise FileNotFoundError(f"Source ONNX model not found: {src_path}")
        if evaluation_report is None or corpus_manifest is None or runtime_evidence is None:
            raise ValueError("Promotion requires hash-bound evaluation, corpus, and runtime evidence")
        validated = validate_context_release(src_path, Path(evaluation_report), Path(corpus_manifest))
        report = validated["report"]
        measurement = json.loads(Path(runtime_evidence).read_text())
        if measurement.get("modelSha256") != report["model_sha256"]:
            raise ValueError("Runtime evidence does not bind this model")
        peak_memory = measurement.get("peakRssMb")
        if not isinstance(peak_memory, (int, float)) or not 0 < peak_memory < 512:
            raise ValueError("Missing, nonfinite, or excessive measured CPU memory")
        metrics = {
            "accuracy": report["metrics"]["accuracy"],
            "f1Score": report["metrics"]["f1"],
            "latencyMs": report["latency_ms_average"],
            "memoryBudgetMb": peak_memory,
        }
        if measurement.get("browserMemoryMeasured") is True:
            memory_note = ("RAM figure is measured Chrome MV3 service-worker peak RSS "
                           "(whole worker process, includes Chromium overhead)")
        else:
            memory_note = "RAM figure is measured CPU process peak RSS, not a browser measurement"
        if (self.checkpoint_manager.registry_dir / f"v{version}").exists() or (self.backend_models_dir / f"v{version}").exists():
            raise FileExistsError("Model versions are immutable; choose an unused version")
        if sync_to_extension and (self.extension_models_dir / "student_model.onnx").exists() and not replace_extension_bundle:
            raise FileExistsError("Explicit approval is required before replacing the existing bundle")

        sha256 = compute_file_sha256(src_path)
        file_size = src_path.stat().st_size

        # 1. Write into lifecycle registry
        version_dir = self.checkpoint_manager.registry_dir / f"v{version}"
        version_dir.mkdir(parents=True, exist_ok=True)
        dest_onnx = version_dir / "student_model.onnx"
        shutil.copy2(src_path, dest_onnx)

        # Build official metadata
        release_date = datetime.now(timezone.utc)
        meta_dict = {
            "version": version,
            "name": name,
            "architecture": architecture,
            "sha256": sha256,
            "fileSizeBytes": file_size,
            "releasedAt": release_date.isoformat().replace("+00:00", "Z"),
            "minExtensionVersion": min_extension_version,
            "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"],
            "metrics": metrics,
            "changelog": [*changelog, "Offline repository-synthetic validation only; no population false-positive claim",
                          memory_note],
            "downloadUrl": f"/v1/models/{version}/download",
            "inputContract": report["input_contract"],
            "validationSummary": validated["summary"],
        }

        manifest_file = version_dir / "manifest.json"
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(meta_dict, f, indent=2)
        shutil.copy2(Path(evaluation_report), version_dir / "evaluation-with-source.json")
        shutil.copy2(src_path.parent / "runtime-acceptance.json", version_dir / "runtime-acceptance.json")
        shutil.copy2(Path(runtime_evidence), version_dir / "runtime-evidence.json")

        backend_target: Optional[str] = None
        extension_target: Optional[str] = None

        # 2. Synchronize to Backend models directory (for /v1/models API serving)
        if sync_to_backend and self.backend_models_dir.exists():
            backend_ver_dir = self.backend_models_dir / f"v{version}"
            backend_ver_dir.mkdir(parents=True, exist_ok=True)
            target = backend_ver_dir / "student_model.onnx"
            shutil.copy2(src_path, target)
            shutil.copy2(manifest_file, backend_ver_dir / "manifest.json")
            shutil.copy2(Path(evaluation_report), backend_ver_dir / "evaluation-with-source.json")
            shutil.copy2(src_path.parent / "runtime-acceptance.json", backend_ver_dir / "runtime-acceptance.json")
            shutil.copy2(Path(runtime_evidence), backend_ver_dir / "runtime-evidence.json")
            backend_target = str(target)

        # 3. Synchronize to Extension public models directory (for on-device bundling)
        if sync_to_extension and self.extension_models_dir.exists():
            ext_target = self.extension_models_dir / "student_model.onnx"
            shutil.copy2(src_path, ext_target)
            shutil.copy2(manifest_file, self.extension_models_dir / "student_model.metadata.json")
            extension_target = str(ext_target)

        return PromotionResult(
            version=version,
            sha256=sha256,
            file_size_bytes=file_size,
            registry_path=str(dest_onnx),
            backend_model_path=backend_target,
            extension_model_path=extension_target,
            promoted_at=release_date.isoformat(),
            success=True,
        )

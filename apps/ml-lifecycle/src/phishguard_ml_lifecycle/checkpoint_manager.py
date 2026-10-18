"""Checkpoint Manager for tracking, persisting, and evaluating model artifacts."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
import torch
import torch.nn as nn
from pydantic import BaseModel, Field


class CheckpointMetadata(BaseModel):
    """Metadata schema accompanying saved model checkpoints."""

    checkpoint_id: str
    stage: str = Field(..., description="Checkpoint stage: 'raw', 'candidate', 'onnx', 'registry'")
    model_name: str
    architecture: str
    epoch: Optional[int] = None
    step: Optional[int] = None
    loss: Optional[float] = None
    metrics: Dict[str, float] = Field(default_factory=dict)
    sha256: str
    file_size_bytes: int
    created_at: str
    hyperparameters: Dict[str, Any] = Field(default_factory=dict)
    extra_notes: Optional[str] = None


def compute_file_sha256(file_path: Path) -> str:
    """Compute SHA-256 cryptographic digest for a binary or artifact."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


class CheckpointManager:
    """Manages storage, manifests, and lifecycle progression of model checkpoints."""

    def __init__(self, base_dir: Optional[Path] = None):
        if base_dir is None:
            # Default to apps/ml-lifecycle/checkpoints
            self.base_dir = Path(__file__).resolve().parent.parent.parent / "checkpoints"
        else:
            self.base_dir = Path(base_dir).resolve()

        self.raw_dir = self.base_dir / "raw"
        self.candidate_dir = self.base_dir / "candidate"
        self.onnx_dir = self.base_dir / "onnx"
        self.registry_dir = self.base_dir / "registry"

        # Ensure base directories exist
        for d in [self.raw_dir, self.candidate_dir, self.onnx_dir, self.registry_dir]:
            d.mkdir(parents=True, exist_ok=True)

    def save_raw_checkpoint(
        self,
        model: nn.Module,
        optimizer: Optional[torch.optim.Optimizer] = None,
        epoch: int = 0,
        step: int = 0,
        loss: float = 0.0,
        metrics: Optional[Dict[str, float]] = None,
        config: Optional[Dict[str, Any]] = None,
        checkpoint_id: Optional[str] = None,
    ) -> Path:
        """Persist a raw training checkpoint with PyTorch weights and manifest."""
        metrics = metrics or {}
        config = config or {}
        cid = checkpoint_id or f"raw_ep{epoch:03d}_step{step:05d}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"

        chk_path = self.raw_dir / f"{cid}.pt"
        manifest_path = self.raw_dir / f"{cid}.json"

        payload = {
            "epoch": epoch,
            "step": step,
            "model_state_dict": model.state_dict(),
            "loss": loss,
            "metrics": metrics,
            "config": config,
        }
        if optimizer is not None:
            payload["optimizer_state_dict"] = optimizer.state_dict()

        torch.save(payload, chk_path)

        sha256 = compute_file_sha256(chk_path)
        meta = CheckpointMetadata(
            checkpoint_id=cid,
            stage="raw",
            model_name=config.get("model_name", "phishguard-student"),
            architecture=config.get("architecture", model.__class__.__name__),
            epoch=epoch,
            step=step,
            loss=loss,
            metrics=metrics,
            sha256=sha256,
            file_size_bytes=chk_path.stat().st_size,
            created_at=datetime.now(timezone.utc).isoformat(),
            hyperparameters=config.get("hyperparameters", {}),
        )

        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(meta.model_dump(), f, indent=2)

        return chk_path

    def load_checkpoint(
        self,
        checkpoint_path: Path,
        model: nn.Module,
        optimizer: Optional[torch.optim.Optimizer] = None,
    ) -> Dict[str, Any]:
        """Load weights from a checkpoint path into model and optional optimizer."""
        checkpoint_path = Path(checkpoint_path)
        if not checkpoint_path.exists():
            raise FileNotFoundError(f"Checkpoint not found at: {checkpoint_path}")

        checkpoint_data = torch.load(checkpoint_path, map_location="cpu")
        model.load_state_dict(checkpoint_data["model_state_dict"])

        if optimizer is not None and "optimizer_state_dict" in checkpoint_data:
            optimizer.load_state_dict(checkpoint_data["optimizer_state_dict"])

        return checkpoint_data

    def promote_to_candidate(
        self,
        raw_checkpoint_path: Path,
        evaluation_metrics: Dict[str, float],
        notes: Optional[str] = None,
        evaluation_report: Optional[Path] = None,
        candidate_onnx: Optional[Path] = None,
        corpus_manifest: Optional[Path] = None,
    ) -> Path:
        """Promote a raw checkpoint that passed validation to candidate stage."""
        raw_path = Path(raw_checkpoint_path)
        if not raw_path.exists():
            raise FileNotFoundError(f"Source checkpoint not found: {raw_path}")
        if evaluation_report is None or candidate_onnx is None or corpus_manifest is None:
            raise ValueError("Candidate promotion requires a validated hash-bound report")
        from .release_validation import validate_context_release
        validated = validate_context_release(Path(candidate_onnx), Path(evaluation_report), Path(corpus_manifest))
        report = validated["report"]
        if report.get("source_checkpoint_sha256") != compute_file_sha256(raw_path):
            raise ValueError("Evaluation report does not bind this raw checkpoint")
        evaluation_metrics = {
            "accuracy": report["metrics"]["accuracy"],
            "f1": report["metrics"]["f1"],
            "false_positive_rate": report["metrics"]["false_positive_rate"],
            "brier": report["metrics"]["brier"],
        }

        candidate_name = f"candidate_{raw_path.stem}"
        target_pt = self.candidate_dir / f"{candidate_name}.pt"
        target_manifest = self.candidate_dir / f"{candidate_name}.json"

        # Copy weight binary
        torch.save(torch.load(raw_path, map_location="cpu"), target_pt)

        # Build candidate manifest
        sha256 = compute_file_sha256(target_pt)
        raw_manifest_path = raw_path.with_suffix(".json")
        base_meta = {}
        if raw_manifest_path.exists():
            with open(raw_manifest_path, "r", encoding="utf-8") as f:
                base_meta = json.load(f)

        meta = CheckpointMetadata(
            checkpoint_id=candidate_name,
            stage="candidate",
            model_name=base_meta.get("model_name", "phishguard-student-candidate"),
            architecture=base_meta.get("architecture", "DistilledStudentModel"),
            epoch=base_meta.get("epoch"),
            step=base_meta.get("step"),
            loss=base_meta.get("loss"),
            metrics=evaluation_metrics,
            sha256=sha256,
            file_size_bytes=target_pt.stat().st_size,
            created_at=datetime.now(timezone.utc).isoformat(),
            hyperparameters=base_meta.get("hyperparameters", {}),
            extra_notes=notes,
        )

        with open(target_manifest, "w", encoding="utf-8") as f:
            json.dump(meta.model_dump(), f, indent=2)

        return target_pt

    def list_checkpoints(self, stage: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all checkpoint manifests across stages or for a specified stage."""
        target_stages = ["raw", "candidate", "onnx", "registry"] if stage is None else [stage]
        results = []

        for stg in target_stages:
            stg_dir = getattr(self, f"{stg}_dir", None)
            if not stg_dir or not stg_dir.exists():
                continue

            # Check JSON manifests in stage directory (and subdirectories for registry)
            manifest_files = list(stg_dir.rglob("*.json"))
            for mf in manifest_files:
                try:
                    with open(mf, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        data["manifest_path"] = str(mf)
                        results.append(data)
                except Exception:
                    continue

        return results

    def prune_raw_checkpoints(
        self,
        keep_best_k: int = 3,
        metric: str = "loss",
        mode: str = "min",
    ) -> List[Path]:
        """Prune older/worse raw checkpoints, keeping only the top K by given metric."""
        raw_manifests = list(self.raw_dir.glob("*.json"))
        records = []
        for mf in raw_manifests:
            try:
                with open(mf, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    val = data.get("metrics", {}).get(metric, data.get("loss", float("inf") if mode == "min" else float("-inf")))
                    records.append((val, mf, mf.with_suffix(".pt")))
            except Exception:
                continue

        reverse = (mode == "max")
        records.sort(key=lambda x: x[0], reverse=reverse)

        # Keep best K, delete the rest
        retained = records[:keep_best_k]
        to_delete = records[keep_best_k:]

        deleted_paths = []
        for _, mf_path, pt_path in to_delete:
            if pt_path.exists():
                pt_path.unlink()
                deleted_paths.append(pt_path)
            if mf_path.exists():
                mf_path.unlink()

        return deleted_paths

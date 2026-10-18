"""ONNX Export and Edge Validation Pipeline."""

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, Optional
import onnx
import torch
import torch.nn as nn

from phishguard_ml_engine.export.export_onnx import export_student_to_onnx
from phishguard_ml_engine.models.student_model import DistilledStudentModel

from .checkpoint_manager import CheckpointManager, compute_file_sha256


class ModelExportPipeline:
    """Manages compilation of PyTorch checkpoints into verified edge ONNX binaries."""

    def __init__(self, checkpoint_manager: Optional[CheckpointManager] = None):
        self.checkpoint_manager = checkpoint_manager or CheckpointManager()

    def export_checkpoint(
        self,
        checkpoint_path: Path,
        version_label: str,
        seq_length: int = 128,
        include_visual: bool = False,
        include_page_context: bool = False,
    ) -> Path:
        """Load candidate PyTorch checkpoint, export to ONNX, verify integrity, and write manifest."""
        chk_path = Path(checkpoint_path)
        if not chk_path.exists():
            raise FileNotFoundError(f"Checkpoint not found at: {chk_path}")

        # Instantiate matching student model architecture
        chk_data = torch.load(chk_path, map_location="cpu", weights_only=False)
        config = chk_data.get("config", {})
        include_page_context = include_page_context or config.get("include_page_context", False)
        if include_page_context and not config.get("transport_invariant"):
            raise ValueError("Old context checkpoints require an explicit transport-invariance transformation")
        include_visual = include_visual or config.get("include_visual", False)
        model = DistilledStudentModel(
            behavioral_in_channels=6,
            behavioral_dim=config.get("behavioral_dim", 64),
            include_visual=include_visual,
            include_page_context=include_page_context,
        )

        state_dict = chk_data.get("model_state_dict", chk_data)
        model.load_state_dict(state_dict)
        model.eval()

        onnx_filename = f"student_model_{version_label}.onnx"
        out_onnx_path = self.checkpoint_manager.onnx_dir / onnx_filename
        manifest_path = self.checkpoint_manager.onnx_dir / f"student_model_{version_label}.json"

        # Export to ONNX
        export_student_to_onnx(
            model=model,
            output_path=str(out_onnx_path),
            seq_length=seq_length,
            include_visual=include_visual,
            include_page_context=include_page_context,
        )

        # Validate ONNX model with official onnx checker
        onnx_model = onnx.load(str(out_onnx_path))
        onnx.checker.check_model(onnx_model)

        sha256 = compute_file_sha256(out_onnx_path)
        file_size = out_onnx_path.stat().st_size

        # Edge budget check (< 80 MB)
        max_budget = 80 * 1024 * 1024
        if file_size > max_budget:
            raise ValueError(f"Exported model size {file_size / 1024 / 1024:.2f}MB exceeds 80MB limit")

        manifest_data = {
            "version": version_label,
            "stage": "onnx",
            "source_checkpoint": str(chk_path),
            "onnx_path": str(out_onnx_path),
            "sha256": sha256,
            "file_size_bytes": file_size,
            "seq_length": seq_length,
            "include_visual": include_visual,
            "include_page_context": include_page_context,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "opset_version": 17,
        }

        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest_data, f, indent=2)

        return out_onnx_path

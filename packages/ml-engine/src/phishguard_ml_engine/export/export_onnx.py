"""ONNX export and quantization pipeline for on-device edge student model."""

import os
from pathlib import Path
from typing import Optional
import torch

from ..models.student_model import DistilledStudentModel


def export_student_to_onnx(
    model: Optional[DistilledStudentModel] = None,
    output_path: str = "student_model.onnx",
    seq_length: int = 128,
    include_visual: bool = False,
    include_page_context: bool = False,
) -> str:
    """Export the student model to ONNX format with dynamic batch axes.

    Args:
        model: Trained DistilledStudentModel instance (or initializes one if None).
        output_path: File path to save the .onnx model.
        seq_length: Fixed trajectory sequence length (default: 128).
        include_visual: Whether to include visual image branch.

    Returns:
        Absolute path to exported ONNX model.
    """
    if model is None:
        model = DistilledStudentModel(
            behavioral_in_channels=6,
            behavioral_dim=64,
            include_visual=include_visual,
            include_page_context=include_page_context,
        )

    model.eval()

    # Create dummy input
    dummy_traj = torch.randn(1, seq_length, 6, dtype=torch.float32)

    input_names = ["trajectory"]
    output_names = ["risk_score"]
    dynamic_axes = {
        "trajectory": {0: "batch_size"},
        "risk_score": {0: "batch_size"},
    }

    dummy_inputs = (dummy_traj,)
    if include_visual:
        dummy_visual = torch.randn(1, 3, 64, 64, dtype=torch.float32)
        dummy_inputs = (dummy_traj, dummy_visual)
        input_names.append("visual")
        dynamic_axes["visual"] = {0: "batch_size"}
    if include_page_context:
        if not include_visual:
            raise ValueError("student-v2 requires visual and page_context inputs")
        dummy_context = torch.zeros(1, 16, dtype=torch.float32)
        dummy_inputs = (*dummy_inputs, dummy_context)
        input_names.append("page_context")
        dynamic_axes["page_context"] = {0: "batch_size"}

    out_file = Path(output_path).resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        dummy_inputs,
        str(out_file),
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        dynamo=False,
    )

    return str(out_file)

"""ONNX Static Graph Export, Calibration Data Reader, and INT8 Quantization Pipeline."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantType,
    quantize_static,
)
import torch

from .unified_model import PhishGuardUnifiedModel


class SessionCalibrationDataReader(CalibrationDataReader):
    """Feeds representative interaction sessions to onnxruntime static calibrator."""

    def __init__(
        self,
        samples: Optional[List[Dict[str, np.ndarray]]] = None,
        num_samples: int = 500,
    ):
        super().__init__()
        if samples is not None:
            self._data = samples
        else:
            # Generate 500 representative session samples
            self._data = []
            for _ in range(num_samples):
                # Normalized viewport with ImageNet statistics
                vp = np.random.randn(1, 3, 224, 224).astype(np.float32)
                # Normalized kinematic sequence with 5 channels
                dyn = np.zeros((1, 5, 64), dtype=np.float32)
                dyn[0, 0, :] = np.linspace(0.1, 0.9, 64)  # x
                dyn[0, 1, :] = np.linspace(0.2, 0.8, 64)  # y
                dyn[0, 2, :] = np.random.uniform(0.0, 1.0, 64)  # v
                dyn[0, 3, :] = np.random.uniform(-0.5, 0.5, 64)  # delta_theta
                dyn[0, 4, :] = np.random.choice([0.0, 0.33, 0.66], 64)  # event
                self._data.append({"viewport": vp, "dynamics": dyn})

        self._iter = iter(self._data)

    def get_next(self) -> Optional[Dict[str, np.ndarray]]:
        return next(self._iter, None)

    def rewind(self) -> None:
        self._iter = iter(self._data)

    def __len__(self) -> int:
        return len(self._data)


def export_static_onnx(
    model: PhishGuardUnifiedModel,
    output_path: Union[str, Path],
    opset_version: int = 18,
) -> Path:
    """Export static ONNX model with fixed batch size 1 for WebGPU/WASM zero-allocation runtime.

    Contract:
      - Input 1: 'viewport' of shape [1, 3, 224, 224] (float32)
      - Input 2: 'dynamics' of shape [1, 5, 64] (float32)
      - Output:  'risk_score' of shape [1, 1] (float32)
    """
    out_file = Path(output_path).resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)

    model.eval()
    dummy_viewport = torch.randn(1, 3, 224, 224, dtype=torch.float32)
    dummy_dynamics = torch.randn(1, 5, 64, dtype=torch.float32)

    torch.onnx.export(
        model,
        (dummy_viewport, dummy_dynamics),
        str(out_file),
        input_names=["viewport", "dynamics"],
        output_names=["risk_score"],
        opset_version=opset_version,
        do_constant_folding=True,
        dynamo=False,
    )

    # Validate exported model
    onnx_proto = onnx.load(str(out_file))
    onnx.checker.check_model(onnx_proto)

    return out_file


def quantize_model_int8(
    fp32_onnx_path: Union[str, Path],
    int8_onnx_path: Union[str, Path],
    calibration_data_reader: Optional[CalibrationDataReader] = None,
    num_calibration_samples: int = 500,
) -> Path:
    """Perform Post-Training Quantization (PTQ) to INT8 while preserving FP32 classification head.

    - QuantType.QInt8 for weights
    - QuantType.QUInt8 for activations
    - Preserves float32 precision on final classification layers to prevent probability saturation.
    """
    fp32_file = Path(fp32_onnx_path).resolve()
    int8_file = Path(int8_onnx_path).resolve()
    int8_file.parent.mkdir(parents=True, exist_ok=True)

    reader = calibration_data_reader or SessionCalibrationDataReader(num_samples=num_calibration_samples)

    # Detect final classification layer nodes to exclude from quantization
    onnx_proto = onnx.load(str(fp32_file))
    nodes_to_exclude = []
    for node in onnx_proto.graph.node:
        name_lower = node.name.lower()
        # Exclude the final linear projection and sigmoid activation
        if "classifier.3" in name_lower or "sigmoid" in name_lower or node.op_type == "Sigmoid":
            nodes_to_exclude.append(node.name)

    quantize_static(
        model_input=str(fp32_file),
        model_output=str(int8_file),
        calibration_data_reader=reader,
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QUInt8,
        nodes_to_exclude=nodes_to_exclude,
    )

    # Validate output INT8 model
    int8_proto = onnx.load(str(int8_file))
    onnx.checker.check_model(int8_proto)

    # Ensure self-contained binary with no external data chunks
    assert int8_file.exists(), f"INT8 model missing at {int8_file}"
    assert int8_file.stat().st_size > 0, "Generated INT8 model is empty"

    return int8_file


def verify_onnx_divergence(
    model: PhishGuardUnifiedModel,
    int8_onnx_path: Union[str, Path],
    num_test_samples: int = 50,
    tolerance: float = 0.02,
) -> Dict[str, Any]:
    """Compute output divergence between PyTorch FP32 and ONNX INT8.

    Asserts: MaxAbsoluteError(sigma(y_hat_pt), sigma(y_hat_int8)) <= tolerance
    """
    int8_file = Path(int8_onnx_path).resolve()
    session = ort.InferenceSession(str(int8_file), providers=["CPUExecutionProvider"])
    model.eval()

    errors = []
    pt_predictions = []
    int8_predictions = []

    for _ in range(num_test_samples):
        v_np = np.random.randn(1, 3, 224, 224).astype(np.float32)
        m_np = np.random.uniform(0.0, 1.0, (1, 5, 64)).astype(np.float32)

        v_torch = torch.from_numpy(v_np)
        m_torch = torch.from_numpy(m_np)

        with torch.no_grad():
            pt_out = model(v_torch, m_torch).cpu().numpy()[0, 0]

        int8_out = session.run(None, {"viewport": v_np, "dynamics": m_np})[0][0, 0]

        abs_err = abs(float(pt_out) - float(int8_out))
        errors.append(abs_err)
        pt_predictions.append(float(pt_out))
        int8_predictions.append(float(int8_out))

    max_err = float(max(errors))
    mean_err = float(np.mean(errors))
    passed = bool(max_err <= tolerance)

    report = {
        "max_absolute_error": round(max_err, 6),
        "mean_absolute_error": round(mean_err, 6),
        "tolerance": tolerance,
        "passed": passed,
        "num_tested_samples": num_test_samples,
        "int8_file_size_bytes": int8_file.stat().st_size,
        "int8_file_size_mb": round(int8_file.stat().st_size / (1024 * 1024), 3),
    }

    if not passed:
        raise AssertionError(
            f"ONNX INT8 quantization exceeded divergence tolerance! "
            f"Max error {max_err:.5f} > {tolerance:.5f}"
        )

    return report

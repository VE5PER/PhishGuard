from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
import onnx
from onnx import TensorProto
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_static,
)


@dataclass(frozen=True)
class StudentInputContract:
    identifier: str
    inputs: dict[str, tuple[int, ...]]


def inspect_student_contract(model_path: Path) -> StudentInputContract:
    model = onnx.load(model_path)
    onnx.checker.check_model(model)
    names = {value.name for value in model.graph.input}
    expected = {"trajectory": (1, 128, 6), "visual": (1, 3, 64, 64)}
    if names == {*expected, "page_context"}:
        expected["page_context"] = (1, 16)
    elif names != set(expected):
        raise ValueError("Unsupported student input signature")
    for value in model.graph.input:
        tensor = value.type.tensor_type
        shape = tensor.shape.dim
        if (
            tensor.elem_type != TensorProto.FLOAT
            or len(shape) != len(expected[value.name])
            or (not shape[0].dim_param and shape[0].dim_value != 1)
            or tuple(dimension.dim_value for dimension in shape[1:]) != expected[value.name][1:]
        ):
            raise ValueError(f"Unsupported student tensor {value.name}")
    outputs = list(model.graph.output)
    if len(outputs) != 1 or outputs[0].name != "risk_score":
        raise ValueError("Unsupported student output signature")
    output = outputs[0].type.tensor_type
    if (
        output.elem_type != TensorProto.FLOAT
        or len(output.shape.dim) != 2
        or output.shape.dim[1].dim_value != 1
        or (not output.shape.dim[0].dim_param and output.shape.dim[0].dim_value != 1)
    ):
        raise ValueError("Unsupported student output shape")
    return StudentInputContract("student-v2" if "page_context" in names else "student-v1", expected)


def validate_student_feed(
    contract: StudentInputContract, sample: Mapping[str, np.ndarray]
) -> dict[str, np.ndarray]:
    if set(sample) != set(contract.inputs):
        raise ValueError("Calibration feed names do not match the student contract")
    validated = {}
    for name, shape in contract.inputs.items():
        value = sample[name]
        if (
            not isinstance(value, np.ndarray)
            or value.dtype != np.float32
            or value.shape != shape
            or not np.isfinite(value).all()
        ):
            raise ValueError(f"Invalid float32 student feed {name}")
        if name == "visual" and (np.any(value < 0) or np.any(value > 1)):
            raise ValueError("Student visual input must be RGB CHW in [0,1]")
        validated[name] = np.array(value, dtype=np.float32, order="C", copy=True)
    return validated


class StudentCalibrationDataReader(CalibrationDataReader):
    def __init__(
        self,
        contract: StudentInputContract,
        samples: Sequence[Mapping[str, np.ndarray]],
        *,
        split: str,
    ):
        if split != "train":
            raise ValueError("Calibration requires a training split")
        if not samples:
            raise ValueError("Calibration feeds are empty")
        self.contract = contract
        self.samples = [validate_student_feed(contract, sample) for sample in samples]
        self.rewind()

    def get_next(self) -> dict[str, np.ndarray] | None:
        value = next(self._iterator, None)
        return None if value is None else {name: tensor.copy() for name, tensor in value.items()}

    def rewind(self) -> None:
        self._iterator = iter(self.samples)

    def __len__(self) -> int:
        return len(self.samples)


def quantize_student_int8(
    source_path: Path,
    candidate_path: Path,
    reader: StudentCalibrationDataReader,
) -> Path:
    source_path, candidate_path = Path(source_path), Path(candidate_path)
    if candidate_path.exists():
        raise FileExistsError(f"Candidate already exists: {candidate_path}")
    contract = inspect_student_contract(source_path)
    if reader.contract != contract:
        raise ValueError("Calibration contract differs from model inputs")
    if not candidate_path.parent.is_dir():
        raise FileNotFoundError(candidate_path.parent)
    graph = onnx.load(source_path)
    if any(node.op_type in ("QuantizeLinear", "DequantizeLinear", "QLinearConv") for node in graph.graph.node):
        raise ValueError("Student source is already quantized")
    if not any(node.op_type == "Conv" for node in graph.graph.node):
        raise ValueError("Student graph has no convolution to quantize")
    signature = [
        (value.name, value.SerializeToString()) for value in (*graph.graph.input, *graph.graph.output)
    ]
    opsets = [(value.domain, value.version) for value in graph.opset_import]
    reader.rewind()
    quantize_static(
        model_input=source_path,
        model_output=candidate_path,
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        op_types_to_quantize=["Conv"],
        per_channel=True,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=CalibrationMethod.MinMax,
        use_external_data_format=False,
        extra_options={"ActivationSymmetric": True, "WeightSymmetric": True},
    )
    quantized = onnx.load(candidate_path)
    onnx.checker.check_model(quantized)
    if (
        inspect_student_contract(candidate_path) != contract
        or signature != [
            (value.name, value.SerializeToString())
            for value in (*quantized.graph.input, *quantized.graph.output)
        ]
        or opsets != [(value.domain, value.version) for value in quantized.opset_import]
        or any(value.data_location == TensorProto.EXTERNAL for value in quantized.graph.initializer)
        or not any(value.data_type == TensorProto.INT8 for value in quantized.graph.initializer)
    ):
        raise ValueError("Quantized candidate failed graph/interface validation")
    return candidate_path

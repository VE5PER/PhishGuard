from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort
import pytest

from phishguard_ml_lifecycle.student_quantization import (
    StudentCalibrationDataReader,
    inspect_student_contract,
    quantize_student_int8,
)


def student_graph(path: Path) -> Path:
    inputs = [
        helper.make_tensor_value_info("trajectory", TensorProto.FLOAT, ["batch_size", 128, 6]),
        helper.make_tensor_value_info("visual", TensorProto.FLOAT, ["batch_size", 3, 64, 64]),
    ]
    nodes = [
        helper.make_node("Conv", ["visual", "weight"], ["conv"], name="visual/Conv"),
        helper.make_node("ReduceMean", ["conv"], ["visual_score"], axes=[1, 2, 3], keepdims=0),
        helper.make_node("ReduceMean", ["trajectory"], ["trajectory_score"], axes=[1, 2], keepdims=0),
        helper.make_node("Add", ["visual_score", "trajectory_score"], ["combined"]),
        helper.make_node("Unsqueeze", ["combined", "axis"], ["logit"]),
        helper.make_node("Sigmoid", ["logit"], ["risk_score"]),
    ]
    graph = helper.make_graph(
        nodes,
        "student-test",
        inputs,
        [helper.make_tensor_value_info("risk_score", TensorProto.FLOAT, ["batch_size", 1])],
        [
            numpy_helper.from_array(np.full((1, 3, 1, 1), 0.1, np.float32), name="weight"),
            numpy_helper.from_array(np.array([1], np.int64), name="axis"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.save(model, path)
    return path


def feeds(value: float = 0.5) -> dict[str, np.ndarray]:
    return {
        "trajectory": np.zeros((1, 128, 6), np.float32),
        "visual": np.full((1, 3, 64, 64), value, np.float32),
    }


def test_student_calibration_requires_explicit_training_feeds(tmp_path):
    contract = inspect_student_contract(student_graph(tmp_path / "source.onnx"))
    assert contract.identifier == "student-v1"
    assert contract.inputs == {"trajectory": (1, 128, 6), "visual": (1, 3, 64, 64)}
    with pytest.raises(ValueError, match="training"):
        StudentCalibrationDataReader(contract, [feeds()], split="test")
    with pytest.raises(ValueError, match="empty"):
        StudentCalibrationDataReader(contract, [], split="train")
    reader = StudentCalibrationDataReader(contract, [feeds()], split="train")
    first = reader.get_next()
    assert first is not None
    assert reader.get_next() is None
    reader.rewind()
    np.testing.assert_array_equal(reader.get_next()["visual"], first["visual"])


@pytest.mark.parametrize("failure", ["name", "shape", "dtype", "nan", "range"])
def test_student_calibration_rejects_wrong_contract(tmp_path, failure):
    contract = inspect_student_contract(student_graph(tmp_path / "source.onnx"))
    sample = feeds()
    if failure == "name":
        sample["viewport"] = sample.pop("visual")
    elif failure == "shape":
        sample["visual"] = np.zeros((1, 3, 224, 224), np.float32)
    elif failure == "dtype":
        sample["trajectory"] = sample["trajectory"].astype(np.float64)
    elif failure == "nan":
        sample["trajectory"][0, 0, 0] = np.nan
    else:
        sample["visual"][0, 0, 0, 0] = 1.01
    with pytest.raises(ValueError):
        StudentCalibrationDataReader(contract, [sample], split="train")


def test_student_contract_rejects_unified_model_inputs(tmp_path):
    source = student_graph(tmp_path / "source.onnx")
    model = onnx.load(source)
    model.graph.input[0].name = "dynamics"
    for node in model.graph.node:
        for index, name in enumerate(node.input):
            if name == "trajectory":
                node.input[index] = "dynamics"
    onnx.save(model, source)
    with pytest.raises(ValueError, match="signature"):
        inspect_student_contract(source)


def test_student_v2_requires_the_context_feed(tmp_path):
    source = student_graph(tmp_path / "source.onnx")
    model = onnx.load(source)
    model.graph.input.append(
        helper.make_tensor_value_info("page_context", TensorProto.FLOAT, ["batch_size", 16])
    )
    onnx.save(model, source)
    contract = inspect_student_contract(source)
    assert contract.identifier == "student-v2"
    with pytest.raises(ValueError, match="names"):
        StudentCalibrationDataReader(contract, [feeds()], split="train")
    sample = {**feeds(), "page_context": np.zeros((1, 16), np.float32)}
    reader = StudentCalibrationDataReader(contract, [sample], split="train")
    assert reader.get_next()["page_context"].shape == (1, 16)


def test_student_int8_preserves_interface_and_uses_qdq_conv(tmp_path):
    source = student_graph(tmp_path / "source.onnx")
    output = tmp_path / "candidate.onnx"
    reader = StudentCalibrationDataReader(
        inspect_student_contract(source),
        [feeds(0.1), feeds(0.5), feeds(0.9)],
        split="train",
    )
    quantize_student_int8(source, output, reader)
    candidate = onnx.load(output)
    onnx.checker.check_model(candidate)
    assert inspect_student_contract(output) == inspect_student_contract(source)
    assert any(node.op_type == "QuantizeLinear" for node in candidate.graph.node)
    assert any(weight.data_type == TensorProto.INT8 for weight in candidate.graph.initializer)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    runtime = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    score = runtime.run(None, feeds())[0]
    assert score.shape == (1, 1)
    assert np.isfinite(score).all()
    assert 0 <= score[0, 0] <= 1
    with pytest.raises(FileExistsError):
        quantize_student_int8(source, output, reader)
    with pytest.raises(ValueError, match="already quantized"):
        quantize_student_int8(
            output,
            tmp_path / "twice.onnx",
            StudentCalibrationDataReader(inspect_student_contract(output), [feeds()], split="train"),
        )

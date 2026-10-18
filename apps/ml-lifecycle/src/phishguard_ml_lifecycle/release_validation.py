import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx

from .context_corpus import audit_context_corpus
from .context_training import CONTEXT_INPUT_CONTRACT, CONTEXT_GATES, metrics_and_gates


def validate_context_release(
    model_path: Path, report_path: Path, corpus_path: Path, require_runtime_acceptance: bool = True
) -> dict[str, Any]:
    report = json.loads(report_path.read_text())
    corpus = json.loads(corpus_path.read_text())
    audit_context_corpus(corpus)
    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
    if report.get("format") != "student-context-evaluation-v2" or report.get("model_sha256") != digest:
        raise ValueError("Report does not bind this model")
    if report.get("corpus_digest") != corpus["digest"] or report.get("input_contract") != CONTEXT_INPUT_CONTRACT:
        raise ValueError("Report corpus/input contract mismatch")
    if report.get("gates") != CONTEXT_GATES or report.get("thresholds") != dict(safe=0.15, block=0.85):
        raise ValueError("Release gates were changed")
    if report.get("validation_basis") != "repository_synthetic":
        raise ValueError("Unsupported validation basis")
    if report.get("policy_version") != "evidence-v2":
        raise ValueError("Unsupported policy version")
    expected = {record["record_id"]: record for record in corpus["records"] if record["split"] == "test"}
    predictions = report.get("predictions", [])
    if len(predictions) != len(expected) or {row["record_id"] for row in predictions} != set(expected):
        raise ValueError("Incomplete/duplicated evaluation predictions")
    if report.get("independent_test_groups") != len({record["group"] for record in expected.values()}):
        raise ValueError("Incorrect independent group count")
    if report.get("independent_test_bases") != len({record["base_id"] for record in expected.values()}):
        raise ValueError("Incorrect independent base count")
    for row in predictions:
        if row["label"] != expected[row["record_id"]]["label"]:
            raise ValueError("Evaluation label differs from frozen corpus")
        if not np.isfinite(row["evidence_score"]) or not 0 <= row["evidence_score"] <= 1:
            raise ValueError("Invalid evidence prediction")
    binary_predictions = [row for row in predictions if row["label"] is not None]
    scores = np.asarray([row["model_score"] for row in binary_predictions])
    labels = np.asarray([row["label"] for row in binary_predictions])
    evidence = np.asarray([row["evidence_score"] for row in binary_predictions])
    computed = metrics_and_gates(scores, labels, evidence)
    for key in ("tp", "tn", "fp", "fn", "accuracy", "f1", "false_positive_rate", "brier",
                "benign_warning_count", "critical_miss_count"):
        if not np.isclose(computed[key], report["metrics"][key], atol=1e-10, rtol=1e-10):
            raise ValueError(f"Reported metric mismatch: {key}")
    failures = list(computed["gate_failures"])
    for mode in sorted({record["mode"] for record in expected.values()}):
        selected = np.asarray([expected[row["record_id"]]["mode"] == mode for row in binary_predictions])
        regime = metrics_and_gates(scores[selected], labels[selected], evidence[selected])
        failures.extend(f"{mode}:{failure}" for failure in regime["gate_failures"])
    if not np.isfinite(report["latency_ms_average"]) or not 0 <= report["latency_ms_average"] <= 40:
        failures.append("latency")
    if any(not 0.15 <= max(row["model_score"], row["evidence_score"]) <= 0.85 for row in predictions if row["label"] is None):
        failures.append("constructed_ambiguity_routing")
    if model_path.stat().st_size >= 80 * 1024**2:
        failures.append("file_size")
    if not np.isclose(report["file_size_mb"], model_path.stat().st_size / 1024**2, atol=1e-10):
        failures.append("file_size_mismatch")
    if not np.isfinite(report["pytorch_onnx_max_difference"]) or report["pytorch_onnx_max_difference"] > 1e-4:
        failures.append("pytorch_onnx_parity")
    if not report.get("passed_all_gates") or report.get("gate_failures") or failures:
        raise ValueError(f"Model did not pass release gates: {failures or report.get('gate_failures')}")
    graph = onnx.load(model_path)
    onnx.checker.check_model(graph)
    signature = []
    for value in graph.graph.input:
        tensor = value.type.tensor_type
        signature.append((value.name, tensor.elem_type, [dimension.dim_value for dimension in tensor.shape.dim][1:]))
    if signature != [("trajectory", 1, [128, 6]), ("visual", 1, [3, 64, 64]), ("page_context", 1, [16])]:
        raise ValueError("Unsupported graph signature")
    for value in graph.graph.input:
        if value.type.tensor_type.shape.dim[0].dim_param != "batch_size":
            raise ValueError("Graph batch axis is not dynamic")
    if len(graph.graph.output) != 1 or graph.graph.output[0].name != "risk_score":
        raise ValueError("Unsupported graph output")
    runtime_path = model_path.parent / "runtime-acceptance.json"
    if require_runtime_acceptance:
        if not runtime_path.exists():
            raise ValueError("Missing runtime acceptance evidence")
        runtime = json.loads(runtime_path.read_text())
        expected_cases = {
            f"{name}_{scheme}": action
            for name, action in (("sample1", "SAFE"), ("sample2", "AMBIGUOUS"),
                                 ("sample2_repeated", "AMBIGUOUS"), ("sample3", "BLOCK"),
                                 ("landing_white", "SAFE"), ("brand_article", "SAFE"))
            for scheme in ("http", "https")
        }
        expected_cases["synthetic_official_yahoo_login"] = "SAFE"
        if (
            runtime.get("format") != "student-runtime-acceptance-v2"
            or runtime.get("modelSha256") != digest or runtime.get("passed") is not True
            or runtime.get("failures") or {row["name"] for row in runtime.get("cases", [])} != set(expected_cases)
            or len(runtime["cases"]) != len(expected_cases)
            or any(row["expectedAction"] != expected_cases[row["name"]] or row["actualAction"] != expected_cases[row["name"]]
                   for row in runtime["cases"])
            or not np.isfinite(runtime.get("maxCpuWebError", np.nan))
            or not 0 <= runtime["maxCpuWebError"] <= 1e-4
            or not np.isfinite(runtime.get("maxProtocolDelta", np.nan))
            or not 0 <= runtime["maxProtocolDelta"] <= 1e-6
        ):
            raise ValueError("Runtime acceptance failed or does not bind this model")
        if report.get("runtime_acceptance_sha256") and report["runtime_acceptance_sha256"] != hashlib.sha256(runtime_path.read_bytes()).hexdigest():
            raise ValueError("Runtime acceptance evidence changed after report finalization")
    return dict(
        report=report, report_sha256=hashlib.sha256(report_path.read_bytes()).hexdigest(),
        summary=dict(
            passedAllGates=True, modelSha256=digest, corpusDigest=corpus["digest"],
            reportSha256=hashlib.sha256(report_path.read_bytes()).hexdigest(),
            inputContractIdentifier="student-v2", policyVersion=report["policy_version"],
            basis="repository_synthetic", falsePositiveRate=computed["false_positive_rate"],
            benignWarningCount=computed["benign_warning_count"], criticalMissCount=computed["critical_miss_count"],
            independentTestGroups=report["independent_test_groups"],
        ),
    )

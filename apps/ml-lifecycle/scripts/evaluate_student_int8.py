import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import onnx
import onnxruntime as ort

from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from phishguard_ml_lifecycle.context_corpus import (
    ContextStudentDataset,
    audit_context_corpus,
    canonical_json,
    scenario_payload,
)
from phishguard_ml_lifecycle.context_training import CONTEXT_GATES, metrics_and_gates
from phishguard_ml_lifecycle.student_quantization import (
    StudentCalibrationDataReader,
    inspect_student_contract,
    quantize_student_int8,
)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def select_stratified(records, count):
    buckets = defaultdict(list)
    for index, record in enumerate(records):
        buckets[(record["mode"], record["theme"], record["scenario"])].append(index)
    for values in buckets.values():
        values.sort(key=lambda index: hashlib.sha256(records[index]["record_id"].encode()).digest())
    selected = []
    depth = 0
    while len(selected) < min(count, len(records)):
        for key in sorted(buckets):
            values = buckets[key]
            if depth < len(values):
                selected.append(values[depth])
                if len(selected) == min(count, len(records)):
                    return selected
        depth += 1
    return selected


def feed_for(dataset, index, contract):
    trajectory, visual, context, _, evidence = dataset[index]
    feed = {"trajectory": trajectory.numpy()[None], "visual": visual.numpy()[None]}
    if contract.identifier == "student-v2":
        feed["page_context"] = context.numpy()[None]
    return feed, float(evidence[0])


def route(score):
    return "SAFE" if score < 0.15 else "BLOCK" if score > 0.85 else "AMBIGUOUS"


def runtime(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def predict(session, feed):
    start = time.perf_counter()
    score = float(session.run(["risk_score"], feed)[0][0, 0])
    elapsed = (time.perf_counter() - start) * 1000
    if not np.isfinite(score) or not 0 <= score <= 1:
        raise ValueError("Invalid model output")
    return score, elapsed


def frozen_payload(record):
    points = record["pointer_series"]
    if record["mode"] in ("no_trajectory", "neither"):
        points = []
    elif record["mode"] == "sparse":
        points = points[:1]
    payload = scenario_payload(record["scenario"], record["site"], points)
    payload.update(
        telemetryId="11111111-1111-4111-8111-111111111111",
        pageTitle="Frozen synthetic runtime fixture",
        sessionDurationMs=1000,
        keystrokes=[],
        clientTimestamp="2026-10-12T00:00:00.000Z",
    )
    payload["domEvents"] = [
        {
            "eventType": "click",
            "targetBoundingBox": {"x": 0, "y": 0, "width": 100, "height": 40},
            "timestamp": 100,
            **event,
        }
        for event in payload["domEvents"]
    ]
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--calibration-samples", type=int, default=256)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new immutable experiment directory")
    if args.calibration_samples < 1:
        raise ValueError("Calibration size must be positive")
    root = Path(__file__).resolve().parents[3]
    manifest = json.loads(args.corpus.read_text())
    audit_context_corpus(manifest)
    source_hash = sha256(args.model)
    contract = inspect_student_contract(args.model)
    train = ContextStudentDataset(root, manifest, "train")
    test = ContextStudentDataset(root, manifest, "test")
    if contract.identifier == "student-v1":
        train.records = [record for record in train.records if record["mode"] == "full"]
    selected = select_stratified(train.records, args.calibration_samples)
    calibration_ids = [train.records[index]["record_id"] for index in selected]
    test_groups = {record["group"] for record in test.records}
    if any(train.records[index]["group"] in test_groups for index in selected):
        raise ValueError("Calibration/test group leakage")
    calibration = [feed_for(train, index, contract)[0] for index in selected]
    reader = StudentCalibrationDataReader(contract, calibration, split="train")
    args.output.mkdir(parents=True)
    candidate_path = args.output / "student_int8.onnx"
    quantize_student_int8(args.model, candidate_path, reader)
    candidate_hash = sha256(candidate_path)
    (args.output / "calibration.json").write_bytes(
        canonical_json(dict(
            sourceModelSha256=source_hash,
            corpusSha256=sha256(args.corpus),
            corpusDigest=manifest["digest"],
            split="train",
            selection="round-robin mode/theme/scenario strata; sha256(record_id) order within each",
            recordIds=calibration_ids,
            independentGroups=sorted({train.records[index]["group"] for index in selected}),
            inputContract=contract.identifier,
            quantization=dict(
                format="QDQ", operators=["Conv"], perChannel=True,
                weightType="QInt8", activationType="QInt8", calibration="MinMax",
                preservedOperators=["LSTM", "MatMul", "Gemm", "Sigmoid"],
            ),
        )) + b"\n"
    )
    np.savez_compressed(
        args.output / "calibration-feeds.npz",
        **{name: np.concatenate([sample[name] for sample in calibration]) for name in contract.inputs},
    )
    source, candidate = runtime(args.model), runtime(candidate_path)
    warmup = calibration[0]
    for _ in range(20):
        predict(source, warmup)
        predict(candidate, warmup)
    rows = []
    fixture_indices = select_stratified(test.records, 20)
    fixture_by_index = {}
    for index, record in enumerate(test.records):
        feed, evidence_score = feed_for(test, index, contract)
        source_score, source_ms = predict(source, feed)
        candidate_score, candidate_ms = predict(candidate, feed)
        points = frozen_payload(record)["pointerSeries"]
        eligible = contract.identifier == "student-v2" or (
            record["mode"] == "full" and prepare_trajectory(points).available
        )
        source_fused = max(source_score, evidence_score) if eligible else evidence_score
        candidate_fused = max(candidate_score, evidence_score) if eligible else evidence_score
        rows.append(dict(
            recordId=record["record_id"], mode=record["mode"], theme=record["theme"],
            label=record["label"], evidenceScore=evidence_score,
            sourceModelScore=source_score, candidateModelScore=candidate_score,
            modelEligible=eligible,
            sourceAction=route(source_fused), candidateAction=route(candidate_fused),
            expectedAction=record["expected_route"],
            absoluteError=abs(source_score - candidate_score),
            sourceLatencyMs=source_ms, candidateLatencyMs=candidate_ms,
        ))
        if index in fixture_indices:
            fixture_by_index[index] = dict(
                name=record["record_id"],
                payload=frozen_payload(record),
                visualPresent=record["mode"] not in ("no_visual", "neither"),
                feeds={name: tensor.reshape(-1).tolist() for name, tensor in feed.items()},
                nativeScores={source_hash: source_score, candidate_hash: candidate_score},
                evidenceScore=evidence_score,
                modelEligible=eligible,
            )
    binary = [row for row in rows if row["label"] is not None]
    quality = None
    if contract.identifier == "student-v2":
        labels = np.array([row["label"] for row in binary], np.float32)
        evidence = np.array([row["evidenceScore"] for row in binary], np.float32)
        quality = {
            model: metrics_and_gates(
                np.array([row[field] for row in binary], np.float32), labels, evidence
            )
            for model, field in [("source", "sourceModelScore"), ("candidate", "candidateModelScore")]
        }
        quality["candidatePerMode"] = {
            mode: metrics_and_gates(
                np.array([row["candidateModelScore"] for row in binary if row["mode"] == mode]),
                np.array([row["label"] for row in binary if row["mode"] == mode]),
                np.array([row["evidenceScore"] for row in binary if row["mode"] == mode]),
            )
            for mode in sorted({row["mode"] for row in binary})
        }
    max_error = max(row["absoluteError"] for row in rows)
    changed_routes = [row["recordId"] for row in rows if row["sourceAction"] != row["candidateAction"]]
    failures = []
    if max_error > 1e-4:
        failures.append("existing_fp32_parity_gate")
    if changed_routes:
        failures.append("routing_changed")
    if quality is None:
        failures.append("legacy_quality_not_certified_by_context_corpus")
    elif quality["candidate"]["gate_failures"]:
        failures.extend(quality["candidate"]["gate_failures"])
    if quality is not None:
        for mode, metrics in quality["candidatePerMode"].items():
            failures.extend(f"{mode}:{failure}" for failure in metrics["gate_failures"])
    source_latency = float(np.mean([row["sourceLatencyMs"] for row in rows]))
    candidate_latency = float(np.mean([row["candidateLatencyMs"] for row in rows]))
    if candidate_latency >= 40:
        failures.append("native_latency")
    if candidate_path.stat().st_size >= 80 * 1024**2:
        failures.append("file_size")
    if contract.identifier == "student-v2" and any(
        row["label"] is None and row["candidateAction"] != "AMBIGUOUS" for row in rows
    ):
        failures.append("constructed_ambiguity_routing")
    fixtures = dict(
        format="student-cpu-frozen-feeds-v1",
        inputContract=contract.identifier,
        inputShapes={name: list(shape) for name, shape in contract.inputs.items()},
        sourceModelSha256=source_hash,
        candidateModelSha256=candidate_hash,
        corpusDigest=manifest["digest"],
        scope="Frozen constructed repository fixtures, not observed real-site captures",
        cases=[fixture_by_index[index] for index in fixture_indices],
    )
    (args.output / "browser-fixtures.json").write_bytes(canonical_json(fixtures) + b"\n")
    graph = onnx.load(candidate_path)
    report = dict(
        format="student-int8-experiment-v1",
        sourceModelSha256=source_hash, candidateModelSha256=candidate_hash,
        sourceBytes=args.model.stat().st_size, candidateBytes=candidate_path.stat().st_size,
        corpusDigest=manifest["digest"], calibrationSamples=len(selected), testSamples=len(rows),
        independentTestGroups=len(test_groups),
        inputContract=contract.identifier,
        int8InitializerCount=sum(weight.data_type == onnx.TensorProto.INT8 for weight in graph.graph.initializer),
        maxAbsoluteError=max_error,
        meanAbsoluteError=float(np.mean([row["absoluteError"] for row in rows])),
        changedRouteCount=len(changed_routes), changedRouteIds=changed_routes,
        sourceLatencyMsAverage=source_latency,
        candidateLatencyMsAverage=candidate_latency,
        quality=quality, existingGates=CONTEXT_GATES,
        nativeGateFailures=failures,
        nativeEligible=not failures,
        releaseEligible=False,
        limitations=[
            "Native CPU timings are not browser CPU/WASM timings",
            "Browser operator compatibility and peak memory must be measured separately",
            "Constructed synthetic scenarios do not certify real-world accuracy or population FPR",
            "Legacy v1 has no page-context branch, so scenario labels cannot certify its standalone accuracy",
            "No release gate was weakened; neither source nor candidate is promoted by this experiment",
        ],
        predictions=rows,
    )
    (args.output / "evaluation.json").write_text(
        json.dumps(report, indent=2, allow_nan=False, default=lambda value: value.item()) + "\n"
    )
    print(json.dumps({key: value for key, value in report.items() if key not in ["predictions", "quality", "changedRouteIds"]}))


if __name__ == "__main__":
    main()

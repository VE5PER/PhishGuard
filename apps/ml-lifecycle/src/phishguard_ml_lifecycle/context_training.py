import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch.utils.data import DataLoader, TensorDataset

from phishguard_ml_engine.models.student_model import DistilledStudentModel
from phishguard_ml_engine.export.export_onnx import export_student_to_onnx
from phishguard_ml_engine.data.page_context import PAGE_CONTEXT_FEATURES, RISK_POLICY_VERSION
from .context_corpus import ContextStudentDataset, audit_context_corpus, canonical_json


CONTEXT_INPUT_CONTRACT = {
    "identifier": "student-v2",
    "trajectoryPreprocessing": "normalized-coordinate-derivatives-index-linear-v2",
    "inputs": [
        {"name": "trajectory", "dtype": "float32", "shape": [128, 6]},
        {"name": "visual", "dtype": "float32", "shape": [3, 64, 64]},
        {"name": "page_context", "dtype": "float32", "shape": [16]},
    ],
    "contextFeatures": list(PAGE_CONTEXT_FEATURES),
}
CONTEXT_GATES = {
    "min_accuracy": 0.95, "min_f1": 0.95, "max_false_positive_rate": 0.005,
    "max_brier": 0.05, "max_latency_ms": 40.0, "max_file_size_mb": 80.0,
    "max_benign_warning_count": 0, "max_critical_miss_count": 0,
}


def fit_calibration(model: DistilledStudentModel, loader: DataLoader) -> dict[str, float]:
    logits, labels = [], []
    model.eval()
    with torch.no_grad():
        for batch in loader:
            if len(batch) == 3:
                embedding, context, target = batch
                prediction = model.fusion_head(torch.cat([embedding, model.encode_context(context)], dim=-1))
            else:
                trajectory, visual, context, target, _ = batch
                prediction = model.forward_logits(trajectory, visual, context)
            logits.append(prediction)
            labels.append(target)
    z, y = torch.cat(logits).detach(), torch.cat(labels)
    log_temperature = torch.zeros(1, requires_grad=True)
    bias = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_temperature, bias], max_iter=100, line_search_fn="strong_wolfe")

    def closure():
        optimizer.zero_grad()
        temperature = log_temperature.exp().clamp(min=0.05, max=20)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(z / temperature + bias, y)
        loss.backward()
        return loss

    optimizer.step(closure)
    temperature = float(log_temperature.exp().clamp(min=0.05, max=20).detach())
    fitted_bias = float(bias.detach())
    if not math.isfinite(temperature + fitted_bias):
        raise ValueError("Nonfinite calibration")
    model.calibration_temperature.fill_(temperature)
    model.calibration_bias.fill_(fitted_bias)
    return dict(temperature=temperature, bias=fitted_bias)


def train_context_candidate(
    root: Path, manifest: dict[str, Any], output_dir: Path, seed: int,
    epochs: int = 15, batch_size: int = 32,
) -> dict[str, Any]:
    audit_context_corpus(manifest)
    if seed not in (0, 1, 2) or not 1 <= epochs <= 15:
        raise ValueError("Training exceeds the approved bounded recipe")
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    train = ContextStudentDataset(root, manifest, "train")
    val = ContextStudentDataset(root, manifest, "val")
    model = DistilledStudentModel(behavioral_dim=64, include_visual=True, include_page_context=True)
    source_path = root / "apps/ml-lifecycle/checkpoints/raw/raw_ep013_step01300_20261009_202609.pt"
    source = torch.load(source_path, map_location="cpu", weights_only=False)["model_state_dict"]
    model.behavior_trunk.load_state_dict({key.removeprefix("behavior_trunk."): value for key, value in source.items() if key.startswith("behavior_trunk.")})
    model.visual_trunk.load_state_dict({key.removeprefix("visual_trunk."): value for key, value in source.items() if key.startswith("visual_trunk.")})
    for parameter in (*model.behavior_trunk.parameters(), *model.visual_trunk.parameters()):
        parameter.requires_grad_(False)
    model.eval()

    def embedded(dataset: ContextStudentDataset) -> TensorDataset:
        embeddings, contexts, targets = [], [], []
        cache: dict[tuple[str, str, str], torch.Tensor] = {}
        with torch.no_grad():
            for index, record in enumerate(dataset.records):
                trajectory, visual, context, label, _ = dataset[index]
                key = record["base_id"], record["mode"], record["theme"]
                if key not in cache:
                    behavior = model.behavior_trunk.extract_features(trajectory[None]) * context[12]
                    vision = model.visual_trunk(visual[None]) * context[13]
                    cache[key] = torch.cat([behavior, vision], dim=-1).squeeze(0)
                embeddings.append(cache[key])
                contexts.append(context)
                targets.append(label)
        return TensorDataset(torch.stack(embeddings), torch.stack(contexts), torch.stack(targets))

    train_loader = DataLoader(embedded(train), batch_size=batch_size, shuffle=True,
                              generator=torch.Generator().manual_seed(seed))
    val_loader = DataLoader(embedded(val), batch_size=batch_size, shuffle=False)
    optimizer = torch.optim.AdamW([parameter for parameter in model.parameters() if parameter.requires_grad],
                                 lr=0.001, weight_decay=0.0001)
    criterion = torch.nn.BCELoss()
    best_loss, best_state, stale = float("inf"), None, 0
    history = []
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        for embedding, context, labels in train_loader:
            optimizer.zero_grad()
            prediction = torch.sigmoid(model.fusion_head(torch.cat([embedding, model.encode_context(context)], dim=-1)))
            loss = criterion(prediction, labels)
            loss.backward()
            optimizer.step()
            train_loss += float(loss.detach()) * len(labels)
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for embedding, context, labels in val_loader:
                prediction = torch.sigmoid(model.fusion_head(torch.cat([embedding, model.encode_context(context)], dim=-1)))
                val_loss += float(criterion(prediction, labels)) * len(labels)
        val_loss /= len(val)
        record = dict(epoch=epoch + 1, train_loss=train_loss / len(train), val_loss=val_loss)
        history.append(record)
        print(json.dumps(dict(seed=seed, **record)), flush=True)
        if val_loss < best_loss:
            best_loss = val_loss
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if stale >= 4:
            break
    if best_state is None:
        raise ValueError("No finite validation checkpoint")
    model.load_state_dict(best_state)
    calibration = fit_calibration(model, val_loader)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = output_dir / f"context_seed{seed}.pt"
    payload = dict(model_state_dict=model.state_dict(), corpus_digest=manifest["digest"],
                   input_contract=CONTEXT_INPUT_CONTRACT, seed=seed, history=history,
                   best_val_loss=best_loss, calibration=calibration,
                   frozen_encoder_checkpoint_sha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
                   config=dict(behavioral_dim=64, include_visual=True, include_page_context=True, transport_invariant=True))
    torch.save(payload, checkpoint)
    return dict(checkpoint=str(checkpoint), best_val_loss=best_loss, seed=seed, history=history, calibration=calibration)


def wilson_interval(successes: int, total: int) -> list[float] | None:
    if total == 0:
        return None
    z = 1.959963984540054
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def metrics_and_gates(scores: np.ndarray, labels: np.ndarray, evidence: np.ndarray) -> dict[str, Any]:
    if len(scores) == 0 or scores.shape != labels.shape or scores.shape != evidence.shape:
        raise ValueError("Invalid evaluation dimensions")
    if not np.isfinite(scores).all() or np.any((scores < 0) | (scores > 1)):
        raise ValueError("Invalid model predictions")
    if set(np.unique(labels).tolist()) != {0.0, 1.0}:
        raise ValueError("Evaluation requires both binary classes")
    positive = scores >= 0.5
    malicious = labels == 1
    tp = int(np.sum(positive & malicious))
    tn = int(np.sum(~positive & ~malicious))
    fp = int(np.sum(positive & ~malicious))
    fn = int(np.sum(~positive & malicious))
    precision = tp / max(tp + fp, 1)
    recall = tp / (tp + fn)
    f1 = 2 * precision * recall / max(precision + recall, 1e-12)
    final = np.floor(np.maximum(scores, evidence) * 1_000_000 + 0.5) / 1_000_000
    benign_warning = int(np.sum((final >= 0.15) & ~malicious))
    critical_miss = int(np.sum((final <= 0.85) & malicious))
    bins = []
    ece = 0.0
    for index in range(10):
        selected = (scores >= index / 10) & ((scores < (index + 1) / 10) if index < 9 else (scores <= 1))
        count = int(np.sum(selected))
        mean_score = float(np.mean(scores[selected])) if count else None
        frequency = float(np.mean(labels[selected])) if count else None
        bins.append(dict(lower=index / 10, upper=(index + 1) / 10, count=count,
                         mean_score=mean_score, phishing_frequency=frequency))
        if count:
            ece += count / len(scores) * abs(mean_score - frequency)
    result = dict(
        tp=tp, tn=tn, fp=fp, fn=fn, accuracy=(tp + tn) / len(labels), precision=precision, recall=recall,
        f1=f1, false_positive_rate=fp / (fp + tn), brier=float(np.mean((scores - labels) ** 2)),
        benign_warning_count=benign_warning, critical_miss_count=critical_miss,
        benign_block_count=int(np.sum((final > 0.85) & ~malicious)),
        malicious_block_recall=float(np.mean(final[malicious] > 0.85)),
        ambiguous_count=int(np.sum((final >= 0.15) & (final <= 0.85))),
        benign_score_quantiles=np.quantile(scores[~malicious], [0, 0.5, 0.95, 0.99, 1]).tolist(),
        fpr_wilson_95=wilson_interval(fp, fp + tn), ece=ece, reliability=bins,
    )
    checks = {
        "accuracy": result["accuracy"] >= CONTEXT_GATES["min_accuracy"],
        "f1": result["f1"] >= CONTEXT_GATES["min_f1"],
        "false_positive_rate": result["false_positive_rate"] <= CONTEXT_GATES["max_false_positive_rate"],
        "brier": result["brier"] <= CONTEXT_GATES["max_brier"],
        "benign_warning_count": benign_warning == 0,
        "critical_miss_count": critical_miss == 0,
    }
    result["gate_failures"] = [name for name, passed in checks.items() if not passed]
    return result


def export_and_evaluate_context(
    root: Path, manifest: dict[str, Any], checkpoint: Path, output_dir: Path,
) -> dict[str, Any]:
    audit_context_corpus(manifest)
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if saved["corpus_digest"] != manifest["digest"] or saved["input_contract"] != CONTEXT_INPUT_CONTRACT:
        raise ValueError("Checkpoint corpus/contract mismatch")
    model = DistilledStudentModel(behavioral_dim=64, include_visual=True, include_page_context=True)
    model.load_state_dict(saved["model_state_dict"])
    model.eval()
    output_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = output_dir / "student_model.onnx"
    if onnx_path.exists():
        raise FileExistsError("Use a new candidate directory; immutable candidate already exists")
    export_student_to_onnx(model, str(onnx_path), include_visual=True, include_page_context=True)
    onnx.checker.check_model(onnx.load(onnx_path))
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    dataset = ContextStudentDataset(root, manifest, "test")
    scores, labels, evidence, modes, latencies = [], [], [], [], []
    max_difference = 0.0
    for index, record in enumerate(dataset.records):
        trajectory, visual, context, label, policy = dataset[index]
        inputs = dict(trajectory=trajectory.numpy()[None], visual=visual.numpy()[None], page_context=context.numpy()[None])
        start = time.perf_counter()
        score = float(session.run(None, inputs)[0].reshape(-1)[0])
        latencies.append((time.perf_counter() - start) * 1000)
        if index < 160:
            with torch.no_grad():
                reference = float(model(trajectory[None], visual[None], context[None]).item())
            max_difference = max(max_difference, abs(score - reference))
        scores.append(score)
        labels.append(float(label.item()))
        evidence.append(float(policy.item()))
        modes.append(record["mode"])
    score_array, label_array, evidence_array = map(np.asarray, (scores, labels, evidence))
    binary = np.asarray([record["label"] is not None for record in dataset.records])
    aggregate = metrics_and_gates(score_array[binary], label_array[binary], evidence_array[binary])
    regimes = {}
    for mode in sorted(set(modes)):
        selected = (np.asarray(modes) == mode) & binary
        regimes[mode] = metrics_and_gates(score_array[selected], label_array[selected], evidence_array[selected])
    failures = list(aggregate["gate_failures"])
    unknown_failures = [
        record["record_id"] for record, score, policy in zip(dataset.records, scores, evidence)
        if record["label"] is None and not 0.15 <= max(score, policy) <= 0.85
    ]
    if unknown_failures:
        failures.append("constructed_ambiguity_routing")
    for mode, result in regimes.items():
        failures.extend(f"{mode}:{failure}" for failure in result["gate_failures"])
    average = float(np.mean(latencies))
    size_mb = onnx_path.stat().st_size / 1024**2
    if average > 40:
        failures.append("latency")
    if size_mb >= 80:
        failures.append("file_size")
    if max_difference > 1e-4:
        failures.append("pytorch_onnx_parity")
    report = dict(
        format="student-context-evaluation-v2", model_sha256=hashlib.sha256(onnx_path.read_bytes()).hexdigest(),
        corpus_digest=manifest["digest"], input_contract=CONTEXT_INPUT_CONTRACT, policy_version=RISK_POLICY_VERSION,
        validation_basis="repository_synthetic", limitations=manifest["limitations"],
        independent_test_groups=len({record["group"] for record in dataset.records}),
        independent_test_bases=len({record["base_id"] for record in dataset.records}),
        thresholds=dict(safe=0.15, block=0.85), gates=CONTEXT_GATES,
        metrics=aggregate, modality_regimes=regimes, latency_ms_average=average,
        runtime="onnxruntime CPU, single-sample full three-input model; not a browser measurement",
        file_size_mb=size_mb, pytorch_onnx_max_difference=max_difference,
        passed_all_gates=not failures, gate_failures=failures, selected_seed=saved["seed"],
        selection_basis="best validation loss across fixed seeds; test not used for selection",
        calibration=saved["calibration"],
        uncertainty_regularizer_note="Constructed uncertain cases target 0.5 during fitting, never count as binary ground truth",
        frozen_encoder_checkpoint_sha256=saved["frozen_encoder_checkpoint_sha256"],
        ambiguity_routing_failures=unknown_failures,
        predictions=[dict(record_id=record["record_id"], label=record["label"], model_score=float(score), evidence_score=float(policy))
                     for record, label, score, policy in zip(dataset.records, labels, scores, evidence)],
    )
    report_path = output_dir / "evaluation.json"
    report_path.write_bytes(canonical_json(report) + b"\n")
    return dict(report_path=str(report_path), onnx_path=str(onnx_path), **report)

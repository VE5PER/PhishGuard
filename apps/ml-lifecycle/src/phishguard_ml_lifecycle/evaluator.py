"""Model evaluation and quality gate verification for candidate checkpoints."""

from datetime import datetime, timezone
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Union
import numpy as np
import torch
import torch.nn as nn
from pydantic import BaseModel, Field

from phishguard_types import SOTABenchmarkReport
from phishguard_ml_engine.data.bezier_synthesizer import generate_synthetic_trajectory
from phishguard_ml_engine.data.trajectory_dataset import create_trajectory_dataloader
from .dataset import create_sota_multimodal_dataloader
from .dataset_storage import SOTA_BENCHMARK_TARGETS, load_dataset_manifest


class EvaluationReport(BaseModel):
    """Evaluation summary and gate check results."""

    model_name: str
    evaluated_at: str
    passed_all_gates: bool
    metrics: Dict[str, float]
    gate_failures: List[str] = Field(default_factory=list)
    latency_ms_avg: float
    file_size_mb: Optional[float] = None
    tri_state_calibration_passed: bool


class ModelEvaluator:
    """Evaluates behavioral and multimodal models against strict production deployment gates."""

    def __init__(
        self,
        min_accuracy: float = 0.95,
        min_f1: float = 0.95,
        max_latency_ms: float = 40.0,
        max_size_mb: float = 80.0,
    ):
        self.min_accuracy = min_accuracy
        self.min_f1 = min_f1
        self.max_latency_ms = max_latency_ms
        self.max_size_mb = max_size_mb

    def evaluate_model(
        self,
        model: nn.Module,
        test_samples: int = 100,
        seq_length: int = 128,
        device: Optional[torch.device] = None,
        model_name: str = "phishguard-model",
        file_size_mb: Optional[float] = None,
    ) -> EvaluationReport:
        """Run comprehensive benchmark suite on model instance."""
        dev = device or torch.device("cpu")
        model = model.to(dev)
        model.eval()

        # 1. Generate test split with physiological variations
        samples = [
            generate_synthetic_trajectory(
                is_phishing=(i % 2 == 1),
                num_steps=seq_length,
            )
            for i in range(test_samples)
        ]
        ground_truth = np.array([1.0 if (i % 2 == 1) else 0.0 for i in range(test_samples)])
        loader = create_trajectory_dataloader(samples, ground_truth.tolist(), batch_size=1, shuffle=False)

        latencies: List[float] = []
        raw_predictions: List[float] = []

        with torch.no_grad():
            for trajs, _ in loader:
                trajs = trajs.to(dev)

                t0 = time.perf_counter()
                pred = model(trajs)
                t1 = time.perf_counter()

                latencies.append((t1 - t0) * 1000.0)
                score = pred.item() if pred.numel() == 1 else pred[0].item()
                raw_predictions.append(score)

        preds_arr = np.array(raw_predictions)
        binary_preds = (preds_arr >= 0.5).astype(float)

        # 2. Compute metrics
        tp = np.sum((binary_preds == 1.0) & (ground_truth == 1.0))
        tn = np.sum((binary_preds == 0.0) & (ground_truth == 0.0))
        fp = np.sum((binary_preds == 1.0) & (ground_truth == 0.0))
        fn = np.sum((binary_preds == 0.0) & (ground_truth == 1.0))

        accuracy = float((tp + tn) / max(len(ground_truth), 1))
        precision = float(tp / max(tp + fp, 1))
        recall = float(tp / max(tp + fn, 1))
        f1_score = float((2 * precision * recall) / max(precision + recall, 1e-8))

        latency_avg = float(np.mean(latencies))

        # 3. Tri-state calibration check:
        # Benign trajectories should generally have low scores (<0.35 in test)
        # Phishing trajectories should have high scores (>0.65 in test)
        benign_scores = preds_arr[ground_truth == 0.0]
        phish_scores = preds_arr[ground_truth == 1.0]
        tri_state_calibrated = bool(
            (np.mean(benign_scores) < 0.40) and (np.mean(phish_scores) > 0.60)
        )

        # 4. Check deployment gates
        gate_failures = []
        if accuracy < self.min_accuracy:
            gate_failures.append(f"Accuracy {accuracy:.3f} < threshold {self.min_accuracy:.3f}")
        if f1_score < self.min_f1:
            gate_failures.append(f"F1 Score {f1_score:.3f} < threshold {self.min_f1:.3f}")
        if latency_avg > self.max_latency_ms:
            gate_failures.append(f"Latency {latency_avg:.2f}ms > threshold {self.max_latency_ms:.2f}ms")
        if file_size_mb is not None and file_size_mb > self.max_size_mb:
            gate_failures.append(f"Size {file_size_mb:.2f}MB > threshold {self.max_size_mb:.2f}MB")
        if not tri_state_calibrated:
            gate_failures.append("Tri-state calibration failed")

        passed_all = len(gate_failures) == 0

        return EvaluationReport(
            model_name=model_name,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            passed_all_gates=passed_all,
            metrics={
                "accuracy": round(accuracy, 4),
                "f1_score": round(f1_score, 4),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
            },
            gate_failures=gate_failures,
            latency_ms_avg=round(latency_avg, 2),
            file_size_mb=round(file_size_mb, 2) if file_size_mb is not None else None,
            tri_state_calibration_passed=tri_state_calibrated,
        )

    def evaluate_visual_model(
        self,
        model: nn.Module,
        test_samples: int = 200,
        seq_length: int = 128,
        seed: int = 12345,
        device: Optional[torch.device] = None,
        model_name: str = "phishguard-student-vision",
        file_size_mb: Optional[float] = None,
        onnx_path: Optional[Union[str, Path]] = None,
    ) -> EvaluationReport:
        """Evaluate the (trajectory, viewport) student against the production gates.

        Latency is measured per sample through onnxruntime (CPU) when `onnx_path` is given,
        otherwise through the PyTorch module. `zero_visual_accuracy` reports accuracy when the
        extension has no frame and feeds an all-zero visual tensor.
        """
        from .visual_student import build_visual_student_tensors

        dev = device or torch.device("cpu")
        model = model.to(dev)
        model.eval()

        trajs, viewports, labels = build_visual_student_tensors(test_samples, seq_length=seq_length, seed=seed)
        ground_truth = labels.squeeze(1).numpy()

        session = None
        if onnx_path is not None:
            import onnxruntime as ort

            session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

        latencies: List[float] = []
        raw_predictions: List[float] = []
        zero_predictions: List[float] = []

        with torch.no_grad():
            for i in range(test_samples):
                traj = trajs[i : i + 1]
                visual = viewports[i : i + 1]

                t0 = time.perf_counter()
                if session is not None:
                    out = session.run(None, {"trajectory": traj.numpy(), "visual": visual.numpy()})[0]
                    score = float(np.asarray(out).reshape(-1)[0])
                else:
                    score = float(model(traj.to(dev), visual.to(dev)).reshape(-1)[0])
                latencies.append((time.perf_counter() - t0) * 1000.0)
                raw_predictions.append(score)

                zero_predictions.append(float(model(traj.to(dev), torch.zeros_like(visual).to(dev)).reshape(-1)[0]))

        preds_arr = np.array(raw_predictions)
        binary_preds = (preds_arr >= 0.5).astype(float)
        tp = np.sum((binary_preds == 1.0) & (ground_truth == 1.0))
        tn = np.sum((binary_preds == 0.0) & (ground_truth == 0.0))
        fp = np.sum((binary_preds == 1.0) & (ground_truth == 0.0))
        fn = np.sum((binary_preds == 0.0) & (ground_truth == 1.0))

        accuracy = float((tp + tn) / max(len(ground_truth), 1))
        precision = float(tp / max(tp + fp, 1))
        recall = float(tp / max(tp + fn, 1))
        f1_score = float((2 * precision * recall) / max(precision + recall, 1e-8))
        zero_accuracy = float(np.mean((np.array(zero_predictions) >= 0.5).astype(float) == ground_truth))
        latency_avg = float(np.mean(latencies))

        benign_scores = preds_arr[ground_truth == 0.0]
        phish_scores = preds_arr[ground_truth == 1.0]
        tri_state_calibrated = bool((np.mean(benign_scores) < 0.40) and (np.mean(phish_scores) > 0.60))

        gate_failures = []
        if accuracy < self.min_accuracy:
            gate_failures.append(f"Accuracy {accuracy:.3f} < threshold {self.min_accuracy:.3f}")
        if f1_score < self.min_f1:
            gate_failures.append(f"F1 Score {f1_score:.3f} < threshold {self.min_f1:.3f}")
        if latency_avg > self.max_latency_ms:
            gate_failures.append(f"Latency {latency_avg:.2f}ms > threshold {self.max_latency_ms:.2f}ms")
        if file_size_mb is not None and file_size_mb > self.max_size_mb:
            gate_failures.append(f"Size {file_size_mb:.2f}MB > threshold {self.max_size_mb:.2f}MB")
        if not tri_state_calibrated:
            gate_failures.append("Tri-state calibration failed (benign mean >= 0.40 or phishing mean <= 0.60)")

        return EvaluationReport(
            model_name=model_name,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            passed_all_gates=len(gate_failures) == 0,
            metrics={
                "accuracy": round(accuracy, 4),
                "f1_score": round(f1_score, 4),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "zero_visual_accuracy": round(zero_accuracy, 4),
            },
            gate_failures=gate_failures,
            latency_ms_avg=round(latency_avg, 2),
            file_size_mb=round(file_size_mb, 2) if file_size_mb is not None else None,
            tri_state_calibration_passed=tri_state_calibrated,
        )

    def evaluate_sota_dataset(
        self,
        model: nn.Module,
        dataset_dir: Union[str, Path],
        split: str = "test",
        batch_size: int = 16,
        device: Optional[torch.device] = None,
        model_name: str = "phishguard-sota-multimodal",
    ) -> SOTABenchmarkReport:
        """Run comprehensive SOTA benchmark verification on multimodal dataset split."""
        dev = device or torch.device("cpu")
        model = model.to(dev)
        model.eval()

        loader = create_sota_multimodal_dataloader(
            dataset_dir, split=split, batch_size=batch_size, shuffle=False, augment=False
        )

        all_preds = []
        all_targets = []
        latencies = []

        with torch.no_grad():
            for batch in loader:
                vp, dyn, url, hid, logo, det, lbl = [item.to(dev) for item in batch]
                t0 = time.perf_counter()
                probs = model(
                    viewport=vp,
                    dynamics=dyn,
                    url_features=url,
                    hid_features=hid,
                    logo_features=logo,
                    detection_features=det,
                )
                t1 = time.perf_counter()
                # Latency per sample in milliseconds
                per_sample_latency = ((t1 - t0) * 1000.0) / max(lbl.size(0), 1)
                latencies.append(per_sample_latency)

                all_preds.extend(probs.cpu().squeeze(-1).numpy().tolist())
                all_targets.extend(lbl.cpu().squeeze(-1).numpy().tolist())

        preds_arr = np.array(all_preds)
        targets_arr = np.array(all_targets)
        binary_preds = (preds_arr >= 0.5).astype(float)

        tp = float(np.sum((binary_preds == 1.0) & (targets_arr == 1.0)))
        tn = float(np.sum((binary_preds == 0.0) & (targets_arr == 0.0)))
        fp = float(np.sum((binary_preds == 1.0) & (targets_arr == 0.0)))
        fn = float(np.sum((binary_preds == 0.0) & (targets_arr == 1.0)))

        accuracy = float((tp + tn) / max(len(targets_arr), 1))
        precision = float(tp / max(tp + fp, 1e-8))
        recall = float(tp / max(tp + fn, 1e-8))
        f1_score = float((2 * precision * recall) / max(precision + recall, 1e-8))
        fpr = float(fp / max(fp + tn, 1e-8))

        roc_auc = None
        try:
            from sklearn.metrics import roc_auc_score
            if len(np.unique(targets_arr)) > 1:
                roc_auc = float(roc_auc_score(targets_arr, preds_arr))
        except Exception as exc:
            raise ValueError("ROC-AUC unavailable; evaluation cannot pass") from exc
        if roc_auc is None:
            raise ValueError("ROC-AUC requires both classes; evaluation cannot pass")

        brier_score = float(np.mean((preds_arr - targets_arr) ** 2))
        avg_latency = float(np.mean(latencies)) if latencies else 0.0

        manifest_version = "1.0.0"
        try:
            m = load_dataset_manifest(dataset_dir)
            manifest_version = m.datasetVersion
        except Exception:
            pass

        gate_failures = []
        if accuracy < SOTA_BENCHMARK_TARGETS["min_accuracy"]:
            gate_failures.append(f"Accuracy {accuracy:.4f} < SOTA {SOTA_BENCHMARK_TARGETS['min_accuracy']:.4f}")
        if precision < SOTA_BENCHMARK_TARGETS["min_precision"]:
            gate_failures.append(f"Precision {precision:.4f} < SOTA {SOTA_BENCHMARK_TARGETS['min_precision']:.4f}")
        if recall < SOTA_BENCHMARK_TARGETS["min_recall"]:
            gate_failures.append(f"Recall {recall:.4f} < SOTA {SOTA_BENCHMARK_TARGETS['min_recall']:.4f}")
        if f1_score < SOTA_BENCHMARK_TARGETS["min_f1"]:
            gate_failures.append(f"F1 Score {f1_score:.4f} < SOTA {SOTA_BENCHMARK_TARGETS['min_f1']:.4f}")
        if fpr > SOTA_BENCHMARK_TARGETS["max_fpr"]:
            gate_failures.append(f"FPR {fpr:.4f} > SOTA limit {SOTA_BENCHMARK_TARGETS['max_fpr']:.4f}")
        if roc_auc < SOTA_BENCHMARK_TARGETS["min_roc_auc"]:
            gate_failures.append(f"ROC-AUC {roc_auc:.4f} < SOTA {SOTA_BENCHMARK_TARGETS['min_roc_auc']:.4f}")
        if brier_score > SOTA_BENCHMARK_TARGETS["max_brier"]:
            gate_failures.append(f"Brier {brier_score:.4f} > SOTA limit {SOTA_BENCHMARK_TARGETS['max_brier']:.4f}")
        if avg_latency > SOTA_BENCHMARK_TARGETS["max_latency_ms"]:
            gate_failures.append(f"Latency {avg_latency:.2f}ms > SOTA limit {SOTA_BENCHMARK_TARGETS['max_latency_ms']:.2f}ms")

        passed_sota = len(gate_failures) == 0

        return SOTABenchmarkReport(
            modelName=model_name,
            evaluatedAt=datetime.now(timezone.utc).isoformat(),
            datasetVersion=manifest_version,
            passedSotaBenchmark=passed_sota,
            accuracy=round(accuracy, 4),
            precision=round(precision, 4),
            recall=round(recall, 4),
            f1Score=round(f1_score, 4),
            falsePositiveRate=round(fpr, 4),
            rocAuc=round(roc_auc, 4),
            brierScore=round(brier_score, 4),
            latencyMsAvg=round(avg_latency, 2),
            benchmarkThresholds=SOTA_BENCHMARK_TARGETS,
            gateFailures=gate_failures,
        )

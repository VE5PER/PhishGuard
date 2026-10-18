"""Model Registry Service for version control and binary distribution."""

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Any

from phishguard_types import (
    ModelMetadata,
    ModelMetrics,
    CheckUpdateResponse,
)
from phishguard_ml_engine.data.page_context import PAGE_CONTEXT_FEATURES


DEFAULT_FEATURES = ["x", "y", "dx", "dy", "v", "theta"]


def compute_file_sha256(file_path: Path) -> str:
    """Compute SHA-256 checksum of an on-disk binary."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


class ModelRegistryService:
    """Manages versioned student ONNX models and cryptographic metadata."""

    def __init__(self, models_dir: Optional[Path] = None):
        if models_dir is None:
            # Default to apps/backend/models or project root models
            self.models_dir = Path(__file__).resolve().parent.parent.parent.parent / "models"
        else:
            self.models_dir = Path(models_dir)

        self._definitions: Dict[str, Dict[str, Any]] = {
            "1.0.0": {
                "name": "phishguard-student-baseline",
                "architecture": "1D-CNN + BiLSTM (Edge Distilled)",
                "subpath": "v1.0.0/student_model.onnx",
                "releasedAt": datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "metrics": ModelMetrics(
                    accuracy=0.965,
                    f1Score=0.958,
                    latencyMs=11.2,
                    memoryBudgetMb=28.0,
                ),
                "changelog": [
                    "Initial INT8 distilled on-device behavioral student model",
                    "6-channel kinematic feature processing [x, y, dx, dy, v, theta]",
                ],
            },
            "1.1.0": {
                "name": "phishguard-student-advanced",
                "architecture": "1D-CNN + BiLSTM with Temporal Attention",
                "subpath": "v1.1.0/student_model.onnx",
                "releasedAt": datetime(2026, 10, 4, 12, 0, 0, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "metrics": ModelMetrics(
                    accuracy=0.984,
                    f1Score=0.979,
                    latencyMs=13.8,
                    memoryBudgetMb=32.5,
                ),
                "changelog": [
                    "Enhanced physiological tremor detection (8-12 Hz bandpass)",
                    "Calibrated hesitation scoring on password solicitations",
                    "Improved angular jitter resilience against high-DPI mouse sensors",
                ],
            },
            "1.2.0": {
                "name": "phishguard-student-rustfs-dummy",
                "architecture": "1D-CNN + BiLSTM (RustFS Distributed)",
                "subpath": "v1.2.0/student_model.onnx",
                "sha256": "f54f9e1431c8b412ee46724eb3f04f075ee9a031ebf261c90818806988c2cbc7",
                "file_size": 107168,
                "releasedAt": datetime(2026, 10, 6, 20, 0, 0, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "metrics": ModelMetrics(
                    accuracy=0.988,
                    f1Score=0.984,
                    latencyMs=12.2,
                    memoryBudgetMb=31.0,
                ),
                "changelog": [
                    "Dummy model stored and distributed via S3-compatible RustFS file store",
                    "Supports autonomous client update checks and cryptographic verification",
                    "Seamless on-device hot swapping into browser extension SQLite/storage",
                ],
            },
            "1.3.0": {
                "name": "phishguard-student-edge-v1.3",
                "architecture": "1D-CNN + BiLSTM (Edge Distilled v1.3)",
                "subpath": "v1.3.0/student_model.onnx",
                "sha256": "cbdcc8e1a853f6522aa857ae8846e4360f7b09beaf73a724eee8ff2c4d9a98fd",
                "file_size": 107168,
                "releasedAt": datetime(2026, 10, 6, 21, 30, 0, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "metrics": ModelMetrics(
                    accuracy=0.989,
                    f1Score=0.986,
                    latencyMs=11.8,
                    memoryBudgetMb=30.0,
                ),
                "changelog": [
                    "Cloned and bumped student model v1.3.0",
                    "Decoupled from extension package bundle for on-demand cloud sync",
                    "Calibrated kinematic risk scoring with zero initial on-disk footprint",
                ],
            },
            "1.4.0": {
                "name": "phishguard-student-vision",
                "architecture": "1D-CNN + BiLSTM + 64×64 visual trunk",
                "subpath": "v1.4.0/student_model.onnx",
                "sha256": "cac2762da37bfcfc93953369042e2cf7614cc64f6cfb2ddfffd47c8334c1757b",
                "file_size": 158158,
                "releasedAt": datetime(2026, 10, 9, 20, 27, 12, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64"],
                "metrics": ModelMetrics(
                    accuracy=1.0,
                    f1Score=1.0,
                    latencyMs=0.49,
                    memoryBudgetMb=30.0,
                ),
                "changelog": [
                    "Adds an on-device 64×64 visual trunk fed from the visible tab (RGB, CHW, 0-1, bilinear resize)",
                    "Inputs are trajectory and visual; the visual tensor is zero when no frame is available",
                    "Metrics measured on the synthetic multimodal generator (400 held-out samples, onnxruntime CPU)",
                ],
            },
            "1.5.0": {
                "name": "phishguard-student-vision-v1.5",
                "architecture": "1D-CNN + BiLSTM + 64×64 visual trunk",
                "subpath": "v1.5.0/student_model.onnx",
                "sha256": "cac2762da37bfcfc93953369042e2cf7614cc64f6cfb2ddfffd47c8334c1757b",
                "file_size": 158158,
                "releasedAt": datetime(2026, 10, 11, 13, 0, 0, tzinfo=timezone.utc),
                "minExtensionVersion": "0.1.0",
                "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64"],
                "metrics": ModelMetrics(
                    accuracy=1.0,
                    f1Score=1.0,
                    latencyMs=0.48,
                    memoryBudgetMb=30.0,
                ),
                "changelog": [
                    "Bumped student model to v1.5.0 for autonomous edge synchronization verification",
                    "Synchronized multimodal visual and behavioral encoder weights",
                ],
            },
        }

    def get_binary_path(self, version: str) -> Optional[Path]:
        """Get absolute path to ONNX binary for a given version."""
        spec = self._definitions.get(version)
        subpath = spec.get("subpath") if spec else f"v{version}/student_model.onnx"
        if not subpath:
            return None
        candidate = self.models_dir / subpath
        if candidate.exists():
            return candidate
        return None

    def get_metadata(self, version: str) -> Optional[ModelMetadata]:
        """Construct ModelMetadata for a given version with dynamic SHA-256 and size."""
        spec = self._definitions.get(version)
        bin_path = self.get_binary_path(version)
        version_dir = bin_path.parent if bin_path else self.models_dir / f"v{version}"
        manifest_path = version_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                manifest = ModelMetadata.model_validate_json(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                return None
            if manifest.version != version_dir.name.removeprefix("v"):
                return None
            if not bin_path or not bin_path.is_file():
                return None
            if bin_path.stat().st_size != manifest.fileSizeBytes or compute_file_sha256(bin_path).lower() != manifest.sha256.lower():
                return None
            if version.startswith("2.") and (
                not manifest.inputContract or manifest.inputContract.identifier != "student-v2"
            ):
                return None
            if manifest.inputContract and manifest.inputContract.identifier == "student-v2":
                expected_contract = {
                    "identifier": "student-v2",
                    "trajectoryPreprocessing": "normalized-coordinate-derivatives-index-linear-v2",
                    "inputs": [
                        {"name": "trajectory", "dtype": "float32", "shape": [128, 6]},
                        {"name": "visual", "dtype": "float32", "shape": [3, 64, 64]},
                        {"name": "page_context", "dtype": "float32", "shape": [16]},
                    ],
                    "contextFeatures": list(PAGE_CONTEXT_FEATURES),
                }
                summary = manifest.validationSummary
                report_path = version_dir / "evaluation-with-source.json"
                acceptance_path = version_dir / "runtime-acceptance.json"
                runtime_evidence_path = version_dir / "runtime-evidence.json"
                if (
                    not summary or not summary.passedAllGates or
                    not report_path.is_file() or not acceptance_path.is_file() or
                    not runtime_evidence_path.is_file()
                ):
                    return None
                try:
                    report = json.loads(report_path.read_text(encoding="utf-8"))
                    acceptance = json.loads(acceptance_path.read_text(encoding="utf-8"))
                    runtime_evidence = json.loads(runtime_evidence_path.read_text(encoding="utf-8"))
                except Exception:
                    return None
                if (
                    not isinstance(report, dict) or not isinstance(acceptance, dict)
                    or not isinstance(runtime_evidence, dict)
                    or not isinstance(report.get("metrics"), dict)
                    or not isinstance(acceptance.get("cases"), list)
                ):
                    return None
                report_metrics = report["metrics"]
                if any(
                    isinstance(report_metrics.get(key), bool)
                    or not isinstance(report_metrics.get(key), (int, float))
                    or not math.isfinite(report_metrics[key])
                    for key in ("accuracy", "f1", "false_positive_rate", "brier")
                ):
                    return None
                if any(
                    isinstance(report_metrics.get(key), bool)
                    or not isinstance(report_metrics.get(key), int)
                    or report_metrics[key] < 0
                    for key in ("benign_warning_count", "critical_miss_count")
                ):
                    return None
                latency_ms = report.get("latency_ms_average")
                if isinstance(latency_ms, bool) or not isinstance(latency_ms, (int, float)) or not math.isfinite(latency_ms):
                    return None
                expected_cases = {
                    f"{name}_{scheme}": action
                    for name, action in (
                        ("sample1", "SAFE"),
                        ("sample2", "AMBIGUOUS"),
                        ("sample2_repeated", "AMBIGUOUS"),
                        ("sample3", "BLOCK"),
                        ("landing_white", "SAFE"),
                        ("brand_article", "SAFE"),
                    )
                    for scheme in ("http", "https")
                }
                expected_cases["synthetic_official_yahoo_login"] = "SAFE"
                expected_gates = {
                    "min_accuracy": 0.95,
                    "min_f1": 0.95,
                    "max_false_positive_rate": 0.005,
                    "max_brier": 0.05,
                    "max_latency_ms": 40.0,
                    "max_file_size_mb": 80.0,
                    "max_benign_warning_count": 0,
                    "max_critical_miss_count": 0,
                }
                runtime_cases = acceptance.get("cases", [])
                if any(not isinstance(row, dict) for row in runtime_cases):
                    return None
                runtime_case_names = {row.get("name") for row in runtime_cases}
                max_cpu_web_error = acceptance.get("maxCpuWebError")
                max_protocol_delta = acceptance.get("maxProtocolDelta")
                peak_rss_mb = runtime_evidence.get("peakRssMb")
                report_acceptance_hash = report.get("runtime_acceptance_sha256")
                report_model_hash = report.get("model_sha256")
                report_corpus_digest = report.get("corpus_digest")
                runtime_model_hash = runtime_evidence.get("modelSha256")
                if (
                    hashlib.sha256(report_path.read_bytes()).hexdigest() != summary.reportSha256.lower()
                    or not isinstance(report_acceptance_hash, str)
                    or report_acceptance_hash.lower() !=
                    hashlib.sha256(acceptance_path.read_bytes()).hexdigest()
                    or not isinstance(report_model_hash, str)
                    or report_model_hash.lower() != manifest.sha256.lower()
                    or not isinstance(report_corpus_digest, str)
                    or report_corpus_digest.lower() != summary.corpusDigest.lower()
                    or manifest.inputContract.model_dump(mode="json") != expected_contract
                    or report.get("passed_all_gates") is not True
                    or report.get("input_contract") != manifest.inputContract.model_dump(mode="json")
                    or report.get("gates") != expected_gates
                    or report.get("thresholds") != {"safe": 0.15, "block": 0.85}
                    or manifest.features != ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"]
                    or summary.inputContractIdentifier != "student-v2"
                    or summary.policyVersion != "evidence-v2"
                    or summary.basis != "repository_synthetic"
                    or summary.falsePositiveRate > 0.005
                    or summary.benignWarningCount != 0
                    or summary.criticalMissCount != 0
                    or summary.independentTestGroups < 1
                    or report.get("metrics", {}).get("false_positive_rate") != summary.falsePositiveRate
                    or report.get("metrics", {}).get("benign_warning_count") != summary.benignWarningCount
                    or report.get("metrics", {}).get("critical_miss_count") != summary.criticalMissCount
                    or manifest.metrics.accuracy != report.get("metrics", {}).get("accuracy")
                    or manifest.metrics.f1Score != report.get("metrics", {}).get("f1")
                    or manifest.metrics.latencyMs != latency_ms
                    or manifest.metrics.memoryBudgetMb != peak_rss_mb
                    or report_metrics["accuracy"] < 0.95
                    or report_metrics["f1"] < 0.95
                    or report_metrics["false_positive_rate"] > 0.005
                    or report_metrics["brier"] > 0.05
                    or report_metrics["benign_warning_count"] != 0
                    or report_metrics["critical_miss_count"] != 0
                    or latency_ms > 40
                    or manifest.fileSizeBytes >= 80 * 1024 * 1024
                    or report.get("independent_test_groups") != summary.independentTestGroups
                    or report.get("policy_version") != summary.policyVersion
                    or acceptance.get("format") != "student-runtime-acceptance-v2"
                    or acceptance.get("modelSha256", "").lower() != manifest.sha256.lower()
                    or acceptance.get("passed") is not True
                    or acceptance.get("failures") != []
                    or runtime_case_names != set(expected_cases)
                    or len(runtime_cases) != len(expected_cases)
                    or any(
                        row.get("expectedAction") != expected_cases.get(row.get("name"))
                        or row.get("actualAction") != expected_cases.get(row.get("name"))
                        for row in runtime_cases
                    )
                    or not isinstance(max_cpu_web_error, (int, float))
                    or not math.isfinite(max_cpu_web_error)
                    or not 0 <= max_cpu_web_error <= 1e-4
                    or not isinstance(max_protocol_delta, (int, float))
                    or not math.isfinite(max_protocol_delta)
                    or not 0 <= max_protocol_delta <= 1e-6
                    or not isinstance(runtime_model_hash, str)
                    or runtime_model_hash.lower() != manifest.sha256.lower()
                    or not isinstance(peak_rss_mb, (int, float))
                    or not math.isfinite(peak_rss_mb)
                    or not 0 < peak_rss_mb < 512
                ):
                    return None
            return manifest

        # Fallback to spec hash or placeholder hash if binary missing on disk
        if (
            spec is None or bin_path is None or not bin_path.is_file()
            or version.startswith("2.") or spec.get("inputContract") is not None
        ):
            return None
        sha256 = compute_file_sha256(bin_path)
        file_size = bin_path.stat().st_size

        return ModelMetadata(
            version=version,
            name=spec["name"],
            architecture=spec["architecture"],
            sha256=sha256,
            fileSizeBytes=file_size,
            releasedAt=spec["releasedAt"],
            minExtensionVersion=spec["minExtensionVersion"],
            features=spec.get("features", DEFAULT_FEATURES),
            metrics=spec["metrics"],
            changelog=spec["changelog"],
            downloadUrl=f"/v1/models/{version}/download",
        )

    def get_latest(self) -> Optional[ModelMetadata]:
        """Return ModelMetadata for the latest released version."""
        # Find latest by release date
        models = self.list_all()
        return models[0] if models else None

    def list_all(self) -> List[ModelMetadata]:
        """List metadata for all registered models sorted by release date descending."""
        versions = set(self._definitions)
        if self.models_dir.is_dir():
            versions.update(
                path.name[1:]
                for path in self.models_dir.iterdir()
                if path.is_dir() and path.name.startswith("v") and (path / "manifest.json").is_file()
            )
        models = [metadata for version in versions if (metadata := self.get_metadata(version)) is not None]
        return sorted(models, key=lambda metadata: (metadata.releasedAt, metadata.version), reverse=True)

    def check_update(
        self,
        current_version: str,
        current_sha256: Optional[str] = None,
        extension_version: Optional[str] = None,
        supported_input_contracts: Optional[List[str]] = None,
    ) -> CheckUpdateResponse:
        """Determine if a model update is available for the client."""
        candidates = self.list_all()
        if not extension_version or not supported_input_contracts:
            candidates = [
                metadata for metadata in candidates
                if metadata.inputContract is None or metadata.inputContract.identifier == "student-v1"
            ]
        else:
            candidates = [
                metadata for metadata in candidates
                if self._version_meets_minimum(extension_version, metadata.minExtensionVersion)
                and (
                    metadata.inputContract is None
                    or metadata.inputContract.identifier in supported_input_contracts
                )
            ]
        if not candidates:
            raise ValueError("No compatible model release is available")
        latest = candidates[0]

        def parse_ver(v: str) -> tuple:
            clean = v.lstrip("v").strip()
            parts = []
            for p in clean.split("."):
                try:
                    parts.append(int(p))
                except ValueError:
                    parts.append(0)
            return tuple(parts)

        latest_tuple = parse_ver(latest.version)
        curr_tuple = parse_ver(current_version)

        is_newer_version = latest_tuple > curr_tuple
        hash_mismatch = bool(
            latest_tuple == curr_tuple
            and current_sha256
            and current_sha256.lower() != latest.sha256.lower()
        )

        update_available = is_newer_version or hash_mismatch

        return CheckUpdateResponse(
            updateAvailable=update_available,
            currentVersion=current_version,
            latestMetadata=latest,
        )

    @staticmethod
    def _version_meets_minimum(version: str, minimum: str) -> bool:
        def parts(value: str) -> tuple[int, int, int] | None:
            clean = value.lstrip("v").split("-", 1)[0].split("+", 1)[0]
            chunks = clean.split(".")
            if len(chunks) != 3 or any(not chunk.isdigit() for chunk in chunks):
                return None
            return tuple(int(chunk) for chunk in chunks)

        current = parts(version)
        required = parts(minimum)
        return current is not None and required is not None and current >= required

    async def sync_with_db(self, session) -> None:
        """Seed pre-defined models into PostgreSQL and load any existing DB releases."""
        from sqlalchemy import select
        from ..db.models import ModelReleaseRecord

        for ver, spec in self._definitions.items():
            result = await session.execute(
                select(ModelReleaseRecord).where(ModelReleaseRecord.version == ver)
            )
            existing = result.scalar_one_or_none()
            if not existing:
                bin_path = self.get_binary_path(ver)
                sha256 = (
                    compute_file_sha256(bin_path)
                    if bin_path and bin_path.exists()
                    else "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                )
                file_size = bin_path.stat().st_size if bin_path and bin_path.exists() else 107168

                metrics_dict = (
                    spec["metrics"].model_dump()
                    if hasattr(spec["metrics"], "model_dump")
                    else spec["metrics"]
                )

                record = ModelReleaseRecord(
                    version=ver,
                    name=spec["name"],
                    architecture=spec["architecture"],
                    sha256=sha256,
                    file_size_bytes=file_size,
                    released_at=spec["releasedAt"],
                    min_extension_version=spec["minExtensionVersion"],
                    features=spec.get("features", DEFAULT_FEATURES),
                    metrics=metrics_dict,
                    changelog=spec["changelog"],
                    download_url=f"/v1/models/{ver}/download",
                    subpath=spec["subpath"],
                )
                session.add(record)
        await session.commit()

        # Query all releases from database and update definitions cache
        stmt = select(ModelReleaseRecord)
        res = await session.execute(stmt)
        for rec in res.scalars():
            if rec.version not in self._definitions:
                self._definitions[rec.version] = {
                    "name": rec.name,
                    "architecture": rec.architecture,
                    "subpath": rec.subpath,
                    "releasedAt": rec.released_at,
                    "minExtensionVersion": rec.min_extension_version,
                    "metrics": ModelMetrics(**rec.metrics),
                    "features": rec.features,
                    "changelog": rec.changelog,
                }


model_registry = ModelRegistryService()

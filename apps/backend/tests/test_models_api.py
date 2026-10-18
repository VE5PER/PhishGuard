"""Integration and API tests for Model Registry Endpoints."""

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from phishguard_backend.main import app
from phishguard_backend.services.model_registry import ModelRegistryService
from phishguard_backend.services.storage import artifact_storage

client = TestClient(app)


@pytest.fixture(autouse=True)
def disable_shared_artifact_storage(monkeypatch):
    async def no_artifact(_key):
        return None

    monkeypatch.setattr(artifact_storage, "get_artifact_meta", no_artifact)


def test_get_latest_model():
    res = client.get("/v1/models/latest")
    assert res.status_code == 200
    data = res.json()
    assert data["version"] == "2.0.0"
    assert data["name"] == "phishguard-student-context-v2"
    assert data["sha256"] == "7b5d1fcb1d945c0c0e5101f264bd948ab31487a17df4a5f30690c63a2f4878c7"
    assert data["fileSizeBytes"] == 167327
    assert "metrics" in data
    assert data["metrics"]["accuracy"] > 0.95
    assert data["features"] == ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"]
    assert data["downloadUrl"] == "/v1/models/2.0.0/download"


def test_list_model_versions():
    res = client.get("/v1/models/versions")
    assert res.status_code == 200
    versions = res.json()
    assert len(versions) >= 7
    # Check sorted descending by release date
    assert versions[0]["version"] == "2.0.0"
    assert versions[1]["version"] == "1.5.0"
    assert versions[2]["version"] == "1.4.0"
    assert versions[3]["version"] == "1.3.0"
    assert versions[4]["version"] == "1.2.0"
    assert versions[5]["version"] == "1.1.0"
    assert versions[6]["version"] == "1.0.0"
    assert len(versions[0]["features"]) == 8
    assert len(versions[3]["features"]) == 6


def test_get_model_by_version():
    res = client.get("/v1/models/1.0.0")
    assert res.status_code == 200
    data = res.json()
    assert data["version"] == "1.0.0"
    assert data["name"] == "phishguard-student-baseline"

    # Nonexistent version
    res_404 = client.get("/v1/models/99.9.9")
    assert res_404.status_code == 404
    assert "not found" in res_404.json()["detail"].lower()


def test_download_model_binary():
    res = client.get("/v1/models/1.1.0/download")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/octet-stream"
    assert "etag" in res.headers
    assert res.headers["x-model-version"] == "1.1.0"

    content = res.content
    assert len(content) > 0

    # Verify SHA-256 checksum matches header
    hasher = hashlib.sha256(content)
    calculated_hash = hasher.hexdigest()
    etag = res.headers["etag"].strip('"')
    assert calculated_hash == etag
    assert res.headers["x-model-sha256"] == calculated_hash


def test_download_dummy_model_from_rustfs():
    """Verify downloading dummy model v1.2.0 served from RustFS storage."""
    res = client.get("/v1/models/1.2.0/download")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/octet-stream"
    assert "etag" in res.headers
    assert res.headers["x-model-version"] == "1.2.0"

    # Verify storage backend is rustfs (or fallback if rustfs offline)
    storage_backend = res.headers.get("x-storage-backend")
    assert storage_backend in ("rustfs", "local-fallback")

    content = res.content
    assert len(content) > 0

    hasher = hashlib.sha256(content)
    calculated_hash = hasher.hexdigest()
    etag = res.headers["etag"].strip('"')
    assert calculated_hash == etag
    assert res.headers["x-model-sha256"] == calculated_hash


def test_check_update_when_newer_available():
    payload = {
        "currentVersion": "1.0.0",
        "currentSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    }
    res = client.post("/v1/models/check-update", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["updateAvailable"] is True
    assert data["currentVersion"] == "1.0.0"
    assert data["latestMetadata"]["version"] == "1.5.0"


def test_check_update_when_already_latest():
    # Fetch latest hash first
    meta = client.get("/v1/models/latest").json()

    payload = {
        "currentVersion": "2.0.0",
        "currentSha256": meta["sha256"],
        "extensionVersion": "0.5.3",
        "supportedInputContracts": ["student-v2"],
    }
    res = client.post("/v1/models/check-update", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["updateAvailable"] is False
    assert data["currentVersion"] == "2.0.0"
    assert data["latestMetadata"]["version"] == "2.0.0"


def test_check_update_keeps_legacy_clients_on_compatible_metadata():
    latest = client.get("/v1/models/latest").json()
    old_client = client.post("/v1/models/check-update", json={
        "currentVersion": "1.5.0",
        "currentSha256": latest["sha256"],
    })
    assert old_client.status_code == 200
    assert old_client.json()["latestMetadata"]["version"] == "1.5.0"

    unsupported_extension = client.post("/v1/models/check-update", json={
        "currentVersion": "1.5.0",
        "currentSha256": latest["sha256"],
        "extensionVersion": "0.0.1",
        "supportedInputContracts": ["student-v2"],
    })
    assert unsupported_extension.status_code == 404


def test_registry_does_not_advertise_missing_or_invalid_context_release(tmp_path):
    registry = ModelRegistryService(models_dir=tmp_path)
    missing = tmp_path / "v2.0.0"
    missing.mkdir()
    assert registry.get_metadata("2.0.0") is None

    (missing / "student_model.onnx").write_bytes(b"not an ONNX model")
    (missing / "manifest.json").write_text(json.dumps({"version": "2.0.0"}), encoding="utf-8")
    assert registry.get_metadata("2.0.0") is None
    assert all(metadata.version != "2.0.0" for metadata in registry.list_all())


def test_registry_accepts_only_report_bound_frozen_context_artifacts(tmp_path):
    candidate_dir = (
        Path(__file__).resolve().parents[3] /
        "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate"
    )
    report_path = candidate_dir / "evaluation-with-source.json"
    acceptance_path = candidate_dir / "runtime-acceptance.json"
    runtime_path = candidate_dir / "runtime-evidence.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    version_dir = tmp_path / "v2.0.0-test"
    version_dir.mkdir()
    shutil.copy2(candidate_dir / "student_model.onnx", version_dir / "student_model.onnx")
    shutil.copy2(report_path, version_dir / report_path.name)
    shutil.copy2(acceptance_path, version_dir / acceptance_path.name)
    shutil.copy2(runtime_path, version_dir / runtime_path.name)
    manifest = {
        "version": "2.0.0-test",
        "name": "unreleased test candidate",
        "architecture": "student-v2",
        "sha256": report["model_sha256"],
        "fileSizeBytes": (candidate_dir / "student_model.onnx").stat().st_size,
        "releasedAt": datetime.now(timezone.utc).isoformat(),
        "minExtensionVersion": "0.4.13",
        "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"],
        "metrics": {
            "accuracy": report["metrics"]["accuracy"],
            "f1Score": report["metrics"]["f1"],
            "latencyMs": report["latency_ms_average"],
            "memoryBudgetMb": runtime["peakRssMb"],
        },
        "changelog": [],
        "downloadUrl": "/v1/models/2.0.0-test/download",
        "inputContract": report["input_contract"],
        "validationSummary": {
            "passedAllGates": report["passed_all_gates"],
            "modelSha256": report["model_sha256"],
            "corpusDigest": report["corpus_digest"],
            "reportSha256": "108010413752248bf5ea86b47e28e26a4a4e0976795f10452d21af2bbc0c4702",
            "inputContractIdentifier": report["input_contract"]["identifier"],
            "policyVersion": report["policy_version"],
            "basis": "repository_synthetic",
            "falsePositiveRate": report["metrics"]["false_positive_rate"],
            "benignWarningCount": report["metrics"]["benign_warning_count"],
            "criticalMissCount": report["metrics"]["critical_miss_count"],
            "independentTestGroups": report["independent_test_groups"],
        },
    }
    (version_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    registry = ModelRegistryService(models_dir=tmp_path)
    assert registry.get_metadata("2.0.0-test") is not None

    mismatched_version = {**manifest, "version": "2.0.1-test"}
    (version_dir / "manifest.json").write_text(json.dumps(mismatched_version), encoding="utf-8")
    assert registry.get_metadata("2.0.0-test") is None
    (version_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    acceptance = json.loads(acceptance_path.read_text(encoding="utf-8"))
    acceptance["cases"][0]["actualAction"] = "BLOCK"
    (version_dir / "runtime-acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
    assert registry.get_metadata("2.0.0-test") is None


def test_registry_memory_ceiling_boundary(tmp_path):
    candidate_dir = (
        Path(__file__).resolve().parents[3] /
        "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate"
    )
    report_path = candidate_dir / "evaluation-with-source.json"
    acceptance_path = candidate_dir / "runtime-acceptance.json"
    runtime_path = candidate_dir / "runtime-evidence.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    version_dir = tmp_path / "v2.0.0-peak"
    version_dir.mkdir()
    shutil.copy2(candidate_dir / "student_model.onnx", version_dir / "student_model.onnx")
    shutil.copy2(report_path, version_dir / report_path.name)
    shutil.copy2(acceptance_path, version_dir / acceptance_path.name)

    def write_artifacts(peak_rss_mb):
        evidence = {**runtime, "peakRssMb": peak_rss_mb}
        (version_dir / runtime_path.name).write_text(json.dumps(evidence), encoding="utf-8")
        manifest = {
            "version": "2.0.0-peak",
            "name": "unreleased test candidate",
            "architecture": "student-v2",
            "sha256": report["model_sha256"],
            "fileSizeBytes": (candidate_dir / "student_model.onnx").stat().st_size,
            "releasedAt": datetime.now(timezone.utc).isoformat(),
            "minExtensionVersion": "0.4.13",
            "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"],
            "metrics": {
                "accuracy": report["metrics"]["accuracy"],
                "f1Score": report["metrics"]["f1"],
                "latencyMs": report["latency_ms_average"],
                "memoryBudgetMb": peak_rss_mb,
            },
            "changelog": [],
            "downloadUrl": "/v1/models/2.0.0-peak/download",
            "inputContract": report["input_contract"],
            "validationSummary": {
                "passedAllGates": report["passed_all_gates"],
                "modelSha256": report["model_sha256"],
                "corpusDigest": report["corpus_digest"],
                "reportSha256": "108010413752248bf5ea86b47e28e26a4a4e0976795f10452d21af2bbc0c4702",
                "inputContractIdentifier": report["input_contract"]["identifier"],
                "policyVersion": report["policy_version"],
                "basis": "repository_synthetic",
                "falsePositiveRate": report["metrics"]["false_positive_rate"],
                "benignWarningCount": report["metrics"]["benign_warning_count"],
                "criticalMissCount": report["metrics"]["critical_miss_count"],
                "independentTestGroups": report["independent_test_groups"],
            },
        }
        (version_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    registry = ModelRegistryService(models_dir=tmp_path)
    for peak, accepted in [
        (200.0, True),
        (511.0, True),
        (511.999, True),
        (512.0, False),
        (600.0, False),
        (0.0, False),
        (-1.0, False),
        (float("nan"), False),
        (float("inf"), False),
    ]:
        write_artifacts(peak)
        assert (registry.get_metadata("2.0.0-peak") is not None) is accepted, f"peakRssMb={peak}"


def test_download_model_v1_3_0():
    res = client.get("/v1/models/1.3.0/download")
    assert res.status_code == 200
    assert res.headers["x-model-version"] == "1.3.0"
    assert len(res.content) == 107168



def test_download_model_v1_4_0_matches_registered_digest():
    meta = client.get("/v1/models/1.4.0").json()
    res = client.get("/v1/models/1.4.0/download")
    assert res.status_code == 200
    assert res.headers["x-model-version"] == "1.4.0"
    assert len(res.content) == meta["fileSizeBytes"]
    assert hashlib.sha256(res.content).hexdigest() == meta["sha256"]


def test_download_model_v1_5_0_matches_registered_digest():
    meta = client.get("/v1/models/1.5.0").json()
    res = client.get("/v1/models/1.5.0/download")
    assert res.status_code == 200
    assert res.headers["x-model-version"] == "1.5.0"
    assert len(res.content) == meta["fileSizeBytes"]
    assert hashlib.sha256(res.content).hexdigest() == meta["sha256"]

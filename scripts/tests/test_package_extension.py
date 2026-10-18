import hashlib
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import package_extension as packager

R3_CANDIDATE = ROOT_DIR / "apps" / "ml-lifecycle" / "checkpoints" / "context-recovery-20261011-r3" / "candidate"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _metadata_for(model_path: Path, report_path: Path, runtime_evidence_path: Path) -> dict:
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    runtime_evidence = _load_json(runtime_evidence_path)
    return {
        "version": "2.0.0",
        "name": "phishguard-student-v2",
        "architecture": "behavioral-visual-page-context student",
        "sha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "fileSizeBytes": model_path.stat().st_size,
        "releasedAt": "2026-10-12T00:00:00Z",
        "minExtensionVersion": "0.4.13",
        "features": ["x", "y", "dx", "dy", "v", "theta", "viewport_rgb_64", "page_context_16"],
        "metrics": {
            "accuracy": report["metrics"]["accuracy"],
            "f1Score": report["metrics"]["f1"],
            "latencyMs": report["latency_ms_average"],
            "memoryBudgetMb": runtime_evidence["peakRssMb"],
        },
        "changelog": [
            "Offline repository-synthetic validation only; no population false-positive claim",
            "RAM figure is measured CPU process peak RSS, not a browser measurement",
        ],
        "downloadUrl": "/v1/models/2.0.0/download",
        "inputContract": report["input_contract"],
        "validationSummary": {
            "passedAllGates": report["passed_all_gates"],
            "modelSha256": report["model_sha256"],
            "corpusDigest": report["corpus_digest"],
            "reportSha256": hashlib.sha256(report_bytes).hexdigest(),
            "inputContractIdentifier": report["input_contract"]["identifier"],
            "policyVersion": report["policy_version"],
            "basis": report["validation_basis"],
            "falsePositiveRate": report["metrics"]["false_positive_rate"],
            "benignWarningCount": report["metrics"]["benign_warning_count"],
            "criticalMissCount": report["metrics"]["critical_miss_count"],
            "independentTestGroups": report["independent_test_groups"],
        },
    }


@pytest.fixture
def package_fixture(tmp_path, monkeypatch):
    extension_dir = tmp_path / "extension"
    downloads_dir = tmp_path / "downloads"
    staging_parent = tmp_path / "build"
    backend_models_dir = tmp_path / "backend" / "models"
    validation_dir = backend_models_dir / "v2.0.0"
    models_dir = extension_dir / "public" / "models"
    model_path = models_dir / "student_model.onnx"
    metadata_path = models_dir / "student_model.metadata.json"
    models_dir.mkdir(parents=True)
    (extension_dir / "dist").mkdir(parents=True)
    (extension_dir / "popup").mkdir()
    (extension_dir / "options").mkdir()
    validation_dir.mkdir(parents=True)
    model_path.write_bytes((R3_CANDIDATE / "student_model.onnx").read_bytes())
    for name in ("evaluation-with-source.json", "runtime-acceptance.json", "runtime-evidence.json"):
        (validation_dir / name).write_bytes((R3_CANDIDATE / name).read_bytes())
    metadata_path.write_text(
        json.dumps(_metadata_for(
            model_path,
            validation_dir / "evaluation-with-source.json",
            validation_dir / "runtime-evidence.json",
        )),
        encoding="utf-8",
    )
    (extension_dir / "manifest.json").write_text(
        json.dumps({"manifest_version": 3, "name": "Test Extension", "version": "0.4.13", "key": "fixture"}),
        encoding="utf-8",
    )
    for filename in ("background.js", "content.js", "popup.js", "options.js"):
        (extension_dir / "dist" / filename).write_text(filename, encoding="utf-8")
    (extension_dir / "popup" / "popup.html").write_text("<html></html>", encoding="utf-8")
    (extension_dir / "options" / "options.html").write_text("<html></html>", encoding="utf-8")

    upload_calls = []
    monkeypatch.setattr(packager, "ensure_extension_built", lambda force_rebuild=False: None)
    monkeypatch.setattr(packager, "load_signing_key", lambda: b"fixture-key")
    monkeypatch.setattr(packager, "assert_key_matches_manifest", lambda _key, _manifest: "a" * 32)
    monkeypatch.setattr(packager, "get_update_base_url", lambda: None)
    monkeypatch.setattr(packager, "pack_crx", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(packager, "_store_artifacts_in_bucket", lambda *args: upload_calls.append(args))
    return {
        "extension_dir": extension_dir,
        "downloads_dir": downloads_dir,
        "staging_parent": staging_parent,
        "backend_models_dir": backend_models_dir,
        "validation_dir": validation_dir,
        "model_path": model_path,
        "metadata_path": metadata_path,
        "upload_calls": upload_calls,
    }


def _package(package_fixture, local_only=True):
    return packager.package_extension(
        local_only=local_only,
        extension_dir=package_fixture["extension_dir"],
        downloads_dir=package_fixture["downloads_dir"],
        staging_parent=package_fixture["staging_parent"],
        backend_models_dir=package_fixture["backend_models_dir"],
    )


def test_local_package_copies_coherent_model_and_sidecar_without_upload(package_fixture):
    stage_sentinel = package_fixture["staging_parent"] / "staging-extension"
    stage_sentinel.mkdir(parents=True)
    marker = stage_sentinel / "keep"
    marker.write_text("preserve", encoding="utf-8")

    _package(package_fixture)

    archive = package_fixture["downloads_dir"] / "phishguard-extension.zip"
    source_metadata = package_fixture["metadata_path"].read_bytes()
    source_model = package_fixture["model_path"].read_bytes()
    with zipfile.ZipFile(archive) as bundle:
        for path in ("models", "dist/models"):
            assert bundle.read(f"{path}/student_model.onnx") == source_model
            assert bundle.read(f"{path}/student_model.metadata.json") == source_metadata
    assert marker.read_text(encoding="utf-8") == "preserve"
    assert list(package_fixture["staging_parent"].iterdir()) == [stage_sentinel]
    assert package_fixture["upload_calls"] == []


def test_only_cpu_wasm_assets_are_packaged(package_fixture):
    assets_dir = package_fixture["extension_dir"] / "public" / "assets"
    assets_dir.mkdir(parents=True)
    (assets_dir / "ort-wasm-simd-threaded.wasm").write_bytes(b"cpu-wasm")
    (assets_dir / "sql-wasm.wasm").write_bytes(b"sql-wasm")
    (assets_dir / "ort-wasm-simd-threaded.jsep.wasm").write_bytes(b"jsep-wasm")
    dist_assets = package_fixture["extension_dir"] / "dist" / "assets"
    dist_assets.mkdir(parents=True)
    (dist_assets / "ort-wasm-simd-threaded.wasm").write_bytes(b"cpu-wasm")
    (dist_assets / "ort-wasm-simd-threaded.jsep-ABCDEF12.wasm").write_bytes(b"hashed-jsep")
    (dist_assets / "config-ABCDEF12.js").write_text("chunk", encoding="utf-8")

    _package(package_fixture)

    with zipfile.ZipFile(package_fixture["downloads_dir"] / "phishguard-extension.zip") as bundle:
        names = bundle.namelist()
        asset_entries = sorted(n for n in names if n.startswith("assets/"))
        dist_wasm_entries = sorted(
            n for n in names if n.startswith("dist/assets/") and n.endswith(".wasm")
        )
    assert asset_entries == [
        "assets/ort-wasm-simd-threaded.wasm",
        "assets/sql-wasm.wasm",
    ]
    assert dist_wasm_entries == ["dist/assets/ort-wasm-simd-threaded.wasm"]
    assert "dist/assets/config-ABCDEF12.js" in names


@pytest.mark.parametrize(
    "peak,accepted",
    [(200.0, True), (511.0, True), (511.999, True), (512.0, False), (0.0, False), (-1.0, False)],
)
def test_runtime_peak_memory_sanity_ceiling_boundary(package_fixture, peak, accepted):
    runtime_path = package_fixture["validation_dir"] / "runtime-evidence.json"
    runtime = _load_json(runtime_path)
    runtime["peakRssMb"] = peak
    runtime_path.write_text(json.dumps(runtime), encoding="utf-8")
    sidecar = _load_json(package_fixture["metadata_path"])
    sidecar["metrics"]["memoryBudgetMb"] = peak
    package_fixture["metadata_path"].write_text(json.dumps(sidecar), encoding="utf-8")

    if accepted:
        _package(package_fixture)
        assert (package_fixture["downloads_dir"] / "phishguard-extension.zip").exists()
    else:
        with pytest.raises(RuntimeError, match="metadata validation failed"):
            _package(package_fixture)
        assert not package_fixture["downloads_dir"].exists()


def test_missing_model_sidecar_fails_before_writing_downloads(package_fixture):
    package_fixture["metadata_path"].unlink()
    with pytest.raises(FileNotFoundError, match="metadata missing"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("sha256", "b" * 64),
        ("fileSizeBytes", 1),
        ("minExtensionVersion", "0.4.14"),
        ("inputContract", {
            "identifier": "student-v2",
            "trajectoryPreprocessing": "normalized-coordinate-derivatives-index-linear-v2",
            "inputs": [
                {"name": "trajectory", "dtype": "float32", "shape": [256, 6]},
                {"name": "visual", "dtype": "float32", "shape": [3, 64, 64]},
                {"name": "page_context", "dtype": "float32", "shape": [16]},
            ],
            "contextFeatures": _load_json(R3_CANDIDATE / "evaluation-with-source.json")["input_contract"]["contextFeatures"],
        }),
    ],
)
def test_incompatible_sidecar_fails_before_writing_downloads(package_fixture, field, value):
    sidecar = _load_json(package_fixture["metadata_path"])
    sidecar[field] = value
    package_fixture["metadata_path"].write_text(json.dumps(sidecar), encoding="utf-8")
    with pytest.raises(RuntimeError, match="metadata validation failed"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()


def test_binary_change_does_not_match_frozen_metadata(package_fixture):
    package_fixture["model_path"].write_bytes(b"changed model bytes")
    with pytest.raises(RuntimeError, match="metadata validation failed"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()


def test_report_summary_mismatch_fails_before_writing_downloads(package_fixture):
    sidecar = _load_json(package_fixture["metadata_path"])
    sidecar["validationSummary"]["reportSha256"] = "d" * 64
    package_fixture["metadata_path"].write_text(json.dumps(sidecar), encoding="utf-8")
    with pytest.raises(RuntimeError, match="metadata validation failed"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()


@pytest.mark.parametrize("tampering", ["weakened_gates", "wrong_runtime_cases", "protocol_delta"])
def test_coherent_report_edits_cannot_weaken_release_acceptance(package_fixture, tampering):
    validation_dir = package_fixture["validation_dir"]
    report_path = validation_dir / "evaluation-with-source.json"
    runtime_path = validation_dir / "runtime-acceptance.json"
    report = _load_json(report_path)
    runtime = _load_json(runtime_path)
    if tampering == "weakened_gates":
        report["gates"]["max_false_positive_rate"] = 1.0
    elif tampering == "wrong_runtime_cases":
        runtime["cases"][0]["name"] = "arbitrary_case"
    else:
        runtime["maxProtocolDelta"] = 0.1
    runtime_path.write_text(json.dumps(runtime), encoding="utf-8")
    report["runtime_acceptance_sha256"] = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
    report_path.write_text(json.dumps(report), encoding="utf-8")
    sidecar = _load_json(package_fixture["metadata_path"])
    sidecar["validationSummary"]["reportSha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
    package_fixture["metadata_path"].write_text(json.dumps(sidecar), encoding="utf-8")
    with pytest.raises(RuntimeError, match="metadata validation failed"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()


def test_existing_versioned_archives_and_latest_files_are_not_overwritten(package_fixture):
    downloads = package_fixture["downloads_dir"]
    downloads.mkdir()
    versioned = downloads / "phishguard-extension-v0.4.13.zip"
    latest = downloads / "phishguard-extension.zip"
    versioned.write_bytes(b"versioned")
    latest.write_bytes(b"latest")
    stage_sentinel = package_fixture["staging_parent"] / "staging-extension"
    stage_sentinel.mkdir(parents=True)
    marker = stage_sentinel / "keep"
    marker.write_text("preserve", encoding="utf-8")

    with pytest.raises(FileExistsError, match="Versioned extension archive already exists"):
        _package(package_fixture)

    assert versioned.read_bytes() == b"versioned"
    assert latest.read_bytes() == b"latest"
    assert marker.read_text(encoding="utf-8") == "preserve"


def test_existing_released_legacy_bundle_recovers_its_real_sidecar_and_packages(package_fixture):
    released_model = ROOT_DIR / "apps/backend/models/v1.5.0/student_model.onnx"
    package_fixture["model_path"].write_bytes(released_model.read_bytes())
    package_fixture["metadata_path"].unlink()
    _package(package_fixture)
    metadata = _load_json(package_fixture["metadata_path"])
    assert metadata["version"] == "1.5.0"
    assert metadata["sha256"] == "cac2762da37bfcfc93953369042e2cf7614cc64f6cfb2ddfffd47c8334c1757b"
    assert "inputContract" not in metadata
    assert "validationSummary" not in metadata
    with zipfile.ZipFile(package_fixture["downloads_dir"] / "phishguard-extension.zip") as archive:
        assert archive.read("models/student_model.onnx") == released_model.read_bytes()
        assert json.loads(archive.read("models/student_model.metadata.json")) == metadata


def test_legacy_bundle_cannot_be_relabelled_as_an_unvalidated_v2_release(package_fixture):
    released_model = ROOT_DIR / "apps/backend/models/v1.5.0/student_model.onnx"
    package_fixture["model_path"].write_bytes(released_model.read_bytes())
    package_fixture["metadata_path"].unlink()
    packager.validate_model_bundle(
        package_fixture["model_path"], package_fixture["metadata_path"],
        package_fixture["backend_models_dir"], "0.5.0", prepare_released_legacy=True,
    )
    metadata = _load_json(package_fixture["metadata_path"])
    metadata["version"] = "2.0.0"
    package_fixture["metadata_path"].write_text(json.dumps(metadata), encoding="utf-8")
    with pytest.raises(RuntimeError, match="metadata validation failed"):
        _package(package_fixture)
    assert not package_fixture["downloads_dir"].exists()

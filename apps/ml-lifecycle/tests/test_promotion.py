"""Tests for ModelPromoter release workflow."""

import json
from pathlib import Path
import pytest

from phishguard_ml_lifecycle.checkpoint_manager import CheckpointManager
from phishguard_ml_lifecycle import promotion
from phishguard_ml_lifecycle.promotion import ModelPromoter


REPO_ROOT = Path(__file__).resolve().parents[3]
R3_CANDIDATE = REPO_ROOT / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate"
R3_REPORT_SHA256 = "108010413752248bf5ea86b47e28e26a4a4e0976795f10452d21af2bbc0c4702"
R3_MODEL_SHA256 = "7b5d1fcb1d945c0c0e5101f264bd948ab31487a17df4a5f30690c63a2f4878c7"


def frozen_validation(model_path: Path, report_path: Path, corpus_path: Path) -> dict:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    if (
        model_path.resolve() != (R3_CANDIDATE / "student_model.onnx").resolve()
        or report.get("model_sha256") != R3_MODEL_SHA256
        or corpus.get("digest") != report.get("corpus_digest")
    ):
        raise ValueError("Frozen report/model/corpus binding mismatch")
    metrics = report["metrics"]
    return {
        "report": report,
        "summary": {
            "passedAllGates": report["passed_all_gates"],
            "modelSha256": report["model_sha256"],
            "corpusDigest": report["corpus_digest"],
            "reportSha256": R3_REPORT_SHA256,
            "inputContractIdentifier": report["input_contract"]["identifier"],
            "policyVersion": report["policy_version"],
            "basis": "repository_synthetic",
            "falsePositiveRate": metrics["false_positive_rate"],
            "benignWarningCount": metrics["benign_warning_count"],
            "criticalMissCount": metrics["critical_miss_count"],
            "independentTestGroups": report["independent_test_groups"],
        },
    }


def make_project(tmp_path: Path):
    manager = CheckpointManager(base_dir=tmp_path / "checkpoints")

    # Create dummy project root with mock backend/extension dirs
    project_root = tmp_path / "mock_repo"
    backend_models = project_root / "apps" / "backend" / "models"
    ext_models = project_root / "apps" / "extension" / "public" / "models"
    backend_models.mkdir(parents=True)
    ext_models.mkdir(parents=True)
    return manager, project_root, backend_models, ext_models


def test_model_promoter_requires_and_binds_evidence_reports(monkeypatch, tmp_path):
    manager, project_root, _backend_models, _ext_models = make_project(tmp_path)

    # Create a mock ONNX binary
    source_onnx = tmp_path / "temp_student.onnx"
    source_onnx.write_bytes(b"dummy onnx binary payload for unit testing")
    promoter = ModelPromoter(checkpoint_manager=manager, project_root=project_root)

    with pytest.raises(ValueError, match="requires hash-bound evaluation"):
        promoter.promote_to_registry(
            onnx_source_path=source_onnx,
            version="test-missing-reports",
            name="test",
            architecture="test",
            metrics={},
            changelog=[],
        )

    report = json.loads((R3_CANDIDATE / "evaluation-with-source.json").read_text())
    corrupt_report = tmp_path / "mismatched-report.json"
    corrupt_report.write_text(json.dumps({**report, "model_sha256": "0" * 64}), encoding="utf-8")
    monkeypatch.setattr(promotion, "validate_context_release", frozen_validation)
    with pytest.raises(ValueError, match="Frozen report/model/corpus binding mismatch"):
        promoter.promote_to_registry(
            onnx_source_path=R3_CANDIDATE / "student_model.onnx",
            version="test-mismatched-report",
            name="test",
            architecture="test",
            metrics={},
            changelog=[],
            evaluation_report=corrupt_report,
            corpus_manifest=REPO_ROOT / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json",
            runtime_evidence=R3_CANDIDATE / "runtime-evidence.json",
            sync_to_extension=False,
        )


def test_model_promoter_propagates_frozen_r3_evidence_in_disposable_root(monkeypatch, tmp_path):
    manager, project_root, backend_models, ext_models = make_project(tmp_path)
    monkeypatch.setattr(promotion, "validate_context_release", frozen_validation)
    promoter = ModelPromoter(checkpoint_manager=manager, project_root=project_root)
    report_path = R3_CANDIDATE / "evaluation-with-source.json"
    corpus_path = REPO_ROOT / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json"
    runtime_evidence = R3_CANDIDATE / "runtime-evidence.json"
    runtime_acceptance = R3_CANDIDATE / "runtime-acceptance.json"

    result = promoter.promote_to_registry(
        onnx_source_path=R3_CANDIDATE / "student_model.onnx",
        version="test-r3-candidate",
        name="unreleased frozen-candidate test",
        architecture="student-v2 test fixture",
        metrics={},
        changelog=[],
        evaluation_report=report_path,
        corpus_manifest=corpus_path,
        runtime_evidence=runtime_evidence,
        sync_to_backend=True,
        sync_to_extension=True,
    )
    assert result.success is True
    assert result.sha256 == R3_MODEL_SHA256

    # Check registry destination
    registry_dir = Path(result.registry_path).parent
    assert (registry_dir / "manifest.json").is_file()
    assert (registry_dir / "evaluation-with-source.json").read_bytes() == report_path.read_bytes()
    assert (registry_dir / "runtime-acceptance.json").read_bytes() == runtime_acceptance.read_bytes()
    assert (registry_dir / "runtime-evidence.json").read_bytes() == runtime_evidence.read_bytes()

    # Check backend destination
    backend_dir = backend_models / "vtest-r3-candidate"
    assert (backend_dir / "manifest.json").is_file()
    assert (backend_dir / "evaluation-with-source.json").read_bytes() == report_path.read_bytes()
    assert (backend_dir / "runtime-acceptance.json").read_bytes() == runtime_acceptance.read_bytes()
    assert (backend_dir / "runtime-evidence.json").read_bytes() == runtime_evidence.read_bytes()

    # Check extension destination
    assert result.extension_model_path is not None
    extension_dir = ext_models
    assert (extension_dir / "student_model.onnx").is_file()
    assert (extension_dir / "student_model.metadata.json").is_file()


def test_model_promoter_memory_ceiling_boundary(monkeypatch, tmp_path):
    manager, project_root, _backend_models, _ext_models = make_project(tmp_path)
    monkeypatch.setattr(promotion, "validate_context_release", frozen_validation)
    promoter = ModelPromoter(checkpoint_manager=manager, project_root=project_root)
    report_path = R3_CANDIDATE / "evaluation-with-source.json"
    corpus_path = REPO_ROOT / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json"
    base_evidence = json.loads((R3_CANDIDATE / "runtime-evidence.json").read_text(encoding="utf-8"))

    def promote_with_peak(peak, version):
        evidence = dict(base_evidence)
        evidence["peakRssMb"] = peak
        evidence_path = tmp_path / f"runtime-evidence-{version}.json"
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        return promoter.promote_to_registry(
            onnx_source_path=R3_CANDIDATE / "student_model.onnx",
            version=version,
            name="unreleased memory-boundary test",
            architecture="student-v2 test fixture",
            metrics={},
            changelog=[],
            evaluation_report=report_path,
            corpus_manifest=corpus_path,
            runtime_evidence=evidence_path,
            sync_to_backend=False,
            sync_to_extension=False,
        )

    for index, peak in enumerate((200.0, 511.0, 511.999)):
        result = promote_with_peak(peak, f"test-peak-ok-{index}")
        assert result.success is True

    for index, peak in enumerate((512.0, 0.0, -1.0, float("nan"), float("inf"))):
        with pytest.raises(ValueError, match="Missing, nonfinite, or excessive measured CPU memory"):
            promote_with_peak(peak, f"test-peak-bad-{index}")


def test_model_promoter_changelog_reflects_memory_measurement_source(monkeypatch, tmp_path):
    manager, project_root, _backend_models, _ext_models = make_project(tmp_path)
    monkeypatch.setattr(promotion, "validate_context_release", frozen_validation)
    promoter = ModelPromoter(checkpoint_manager=manager, project_root=project_root)
    report_path = R3_CANDIDATE / "evaluation-with-source.json"
    corpus_path = REPO_ROOT / "apps/ml-lifecycle/checkpoints/context-recovery-20261011-r2/corpus.json"
    base_evidence = json.loads((R3_CANDIDATE / "runtime-evidence.json").read_text(encoding="utf-8"))

    def promote_with_evidence(browser_measured, version):
        evidence = dict(base_evidence)
        evidence["browserMemoryMeasured"] = browser_measured
        evidence_path = tmp_path / f"runtime-evidence-{version}.json"
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        promoter.promote_to_registry(
            onnx_source_path=R3_CANDIDATE / "student_model.onnx",
            version=version,
            name="unreleased changelog-source test",
            architecture="student-v2 test fixture",
            metrics={},
            changelog=[],
            evaluation_report=report_path,
            corpus_manifest=corpus_path,
            runtime_evidence=evidence_path,
            sync_to_backend=False,
            sync_to_extension=False,
        )
        manifest = json.loads(
            (manager.registry_dir / f"v{version}" / "manifest.json").read_text(encoding="utf-8")
        )
        return manifest["changelog"][-1]

    browser_note = promote_with_evidence(True, "test-changelog-browser")
    assert browser_note == ("RAM figure is measured Chrome MV3 service-worker peak RSS "
                            "(whole worker process, includes Chromium overhead)")

    cpu_note = promote_with_evidence(False, "test-changelog-cpu")
    assert cpu_note == "RAM figure is measured CPU process peak RSS, not a browser measurement"

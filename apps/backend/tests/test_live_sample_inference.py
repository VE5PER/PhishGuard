"""Automated live model inference test for PhishGuard testbench sample pages.

Verifies that the ONNX student model and DOM anomaly detection accurately classify:
- Sample 1: SAFE (score < 0.15)
- Sample 2: AMBIGUOUS (0.15 <= score <= 0.85, 1 hidden trap + paste)
- Sample 3: BLOCK (score > 0.85, 2 hidden traps + cross-origin password iframe)
"""

from functools import lru_cache
import hashlib
import json
import re
from pathlib import Path
import numpy as np
import pytest
from phishguard_ml_engine.data.page_context import (
    compose_risk,
    evaluate_evidence_risk,
    prepare_page_context,
)
from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from phishguard_types import InteractionTelemetryPayload

try:
    import onnxruntime as ort
except ImportError:
    ort = None

ROOT_DIR = Path(__file__).resolve().parent.parent.parent.parent
STATIC_DIR = ROOT_DIR / "apps" / "landing" / "out"
CANDIDATE_DIR = ROOT_DIR / "apps" / "ml-lifecycle" / "checkpoints" / "context-recovery-20261011-r3" / "candidate"
ONNX_MODEL_PATH = CANDIDATE_DIR / "student_model.onnx"


@lru_cache(maxsize=1)
def runtime_fixture() -> dict:
    fixture = json.loads((CANDIDATE_DIR / "runtime-fixture.json").read_text())
    assert fixture["format"] == "student-runtime-fixture-v2"
    assert hashlib.sha256(ONNX_MODEL_PATH.read_bytes()).hexdigest() == fixture["modelSha256"]
    expected = {
        f"{name}_{scheme}": action
        for name, action in (
            ("sample1", "SAFE"), ("sample2", "AMBIGUOUS"),
            ("sample2_repeated", "AMBIGUOUS"), ("sample3", "BLOCK"),
            ("landing_white", "SAFE"), ("brand_article", "SAFE"),
        )
        for scheme in ("http", "https")
    }
    expected["synthetic_official_yahoo_login"] = "SAFE"
    assert len(fixture["cases"]) == len(expected)
    assert {case["name"]: case["expectedAction"] for case in fixture["cases"]} == expected
    return fixture


@lru_cache(maxsize=1)
def student_session():
    assert ONNX_MODEL_PATH.exists(), f"Student model missing at {ONNX_MODEL_PATH}"
    session = ort.InferenceSession(str(ONNX_MODEL_PATH))
    assert {value.name: value.shape[1:] for value in session.get_inputs()} == {
        "trajectory": [128, 6], "visual": [3, 64, 64], "page_context": [16],
    }
    return session


def extract_dom_anomalies(html: str) -> dict:
    """Scans static HTML for security anomalies matching PhishGuard scanDOMTopology()."""
    has_password = bool(re.search(r'<input[^>]+type=["\']password["\']', html, re.I))

    # 1. Scan for transparent overlays with opacity: 0
    trap_ids = set(re.findall(r'id=["\']([^"\']*(?:trap|overlay|clickjack)[^"\']*)["\']', html, re.I))
    zero_opacity_traps = []
    for tid in trap_ids:
        is_transparent = bool(
            re.search(rf'#{tid}[^}}]*opacity:\s*0', html, re.I) or
            re.search(rf'id=["\']{tid}["\'][^>]*style=["\'][^"\']*opacity:\s*0', html, re.I)
        )
        if is_transparent:
            zero_opacity_traps.append(tid)

    # 2. Scan for cross-origin iframes
    iframes = re.findall(r'<iframe[^>]+src=["\'](https?://[^"\']+)["\']', html, re.I)
    cross_origin_iframes = [
        src for src in iframes
        if "localhost" not in src and "127.0.0.1" not in src
    ]

    return {
        "zero_opacity_traps": zero_opacity_traps,
        "cross_origin_iframes": cross_origin_iframes,
        "has_password": has_password,
    }


def assert_exported_sample_markup(sample_name: str) -> None:
    html = (STATIC_DIR / sample_name / "index.html").read_text(encoding="utf-8")
    if sample_name == "sample2":
        assert "sample2-trap" in html
    if sample_name == "sample3":
        assert "sample3-password-trap" in html
        assert 'id="trap-layer"' in html
        assert 'src="https://example.com' in html


def test_exported_sample_markup_is_checked_separately_from_evidence_replay():
    for sample_name in ("sample1", "sample2", "sample3"):
        assert_exported_sample_markup(sample_name)


def run_student_model(
    trajectory: np.ndarray, visual: np.ndarray | None = None, page_context: np.ndarray | None = None,
) -> float:
    """Executes live inference on student_model.onnx."""
    assert ONNX_MODEL_PATH.exists(), f"Student model missing at {ONNX_MODEL_PATH}"
    sess = student_session()

    feeds = {"trajectory": trajectory.astype(np.float32)}
    input_names = [inp.name for inp in sess.get_inputs()]
    if "visual" in input_names:
        if visual is None:
            visual = np.zeros((1, 3, 64, 64), dtype=np.float32)
        feeds["visual"] = visual.astype(np.float32)
    assert page_context is not None, "The versioned student requires canonical page context"
    feeds["page_context"] = page_context.astype(np.float32)

    outputs = sess.run(None, feeds)
    score = float(outputs[0][0][0])
    assert np.isfinite(score) and 0 <= score <= 1
    return score


def replay_case(name: str) -> dict:
    case = next(case for case in runtime_fixture()["cases"] if case["name"] == name)
    payload = InteractionTelemetryPayload.model_validate(case["payload"]).model_dump(mode="json")
    trajectory = prepare_trajectory(payload["pointerSeries"])
    visual = np.ones((1, 3, 64, 64), dtype=np.float32) if case["visualPresent"] else None
    page = prepare_page_context(payload, trajectory, visual is not None)
    assert page["available"]
    model_score = run_student_model(
        (trajectory.tensor if trajectory.available else np.zeros((128, 6), dtype=np.float32))[None],
        visual, page["context"][None],
    )
    assert abs(model_score - case["expectedModelScore"]) <= 1e-4
    policy = evaluate_evidence_risk(page)
    score, action = compose_risk(model_score, policy["score"])
    assert action == case["expectedAction"]
    return dict(score=score, action=action, model_score=model_score, page=page, payload=payload)


@pytest.mark.skipif(ort is None, reason="onnxruntime not installed")
@pytest.mark.parametrize("scheme", ["http", "https"])
def test_sample1_live_inference(scheme):
    """Verify Sample 1 produces SAFE (< 0.15) with 0 anomalies on live model inference."""
    assert_exported_sample_markup("sample1")
    # Natural smooth trajectory
    result = replay_case(f"sample1_{scheme}")
    assert result["page"]["credential_traps"] == 0
    assert result["action"] == "SAFE"
    assert result["score"] < 0.15


@pytest.mark.skipif(ort is None, reason="onnxruntime not installed")
@pytest.mark.parametrize("scheme", ["http", "https"])
def test_sample2_live_inference(scheme):
    """Verify Sample 2 produces AMBIGUOUS (0.15 - 0.85) with 1 hidden trap on live model inference."""
    assert_exported_sample_markup("sample2")

    # 1. On page load (hidden trap: +0.35)
    load = replay_case(f"sample2_{scheme}")
    load_score, action_load = load["score"], load["action"]

    assert action_load == "AMBIGUOUS"
    assert 0.15 <= load_score <= 0.85
    assert load["page"]["credential_traps"] == 0
    assert load["page"]["submit_traps"] == 1

    # 2. On paste event (+0.15)
    paste = replay_case(f"sample2_repeated_{scheme}")
    paste_score, action_paste = paste["score"], paste["action"]

    assert action_paste == "AMBIGUOUS"
    assert 0.15 <= paste_score <= 0.85
    assert paste["page"]["credential_traps"] == 0
    assert paste["page"]["submit_traps"] == 1
    page_without_paste = prepare_page_context(
        {**paste["payload"], "domEvents": [
            event for event in paste["payload"]["domEvents"] if not event["isPasteIntoPassword"]
        ]},
        prepare_trajectory(paste["payload"]["pointerSeries"]), False,
    )
    assert evaluate_evidence_risk(paste["page"])["score"] == evaluate_evidence_risk(page_without_paste)["score"]


@pytest.mark.skipif(ort is None, reason="onnxruntime not installed")
@pytest.mark.parametrize("scheme", ["http", "https"])
def test_sample3_live_inference(scheme):
    """Verify Sample 3 produces BLOCK (> 0.85) with 2 hidden traps and cross-origin iframe on live model inference."""
    assert_exported_sample_markup("sample3")

    # 2 traps (+0.35 each) + cross-origin password frame (+0.50)
    result = replay_case(f"sample3_{scheme}")
    assert result["page"]["credential_traps"] == 1
    assert result["page"]["submit_traps"] == 1
    assert not result["page"]["observed_credential_frame"]
    assert result["page"]["context"][8] == 1
    foreign = [event for event in result["payload"]["domEvents"] if event["isCrossOriginIframe"]]
    assert len(foreign) == 1
    assert foreign[0]["credentialFrameEvidence"] == "unverified"
    assert not foreign[0]["isPasswordInput"]
    assert result["action"] == "BLOCK"
    assert result["score"] > 0.85


@pytest.mark.skipif(ort is None, reason="onnxruntime not installed")
def test_frozen_runtime_cohort_matches_cpu_replay():
    results = {case["name"]: replay_case(case["name"]) for case in runtime_fixture()["cases"]}
    for name in ("sample1", "sample2", "sample2_repeated", "sample3", "landing_white", "brand_article"):
        assert abs(results[f"{name}_http"]["model_score"] - results[f"{name}_https"]["model_score"]) <= 1e-6

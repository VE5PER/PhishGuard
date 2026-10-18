import numpy as np
import pytest

from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from phishguard_ml_engine.data.page_context import prepare_page_context, evaluate_evidence_risk, compose_risk


def points(scale=1):
    return [
        dict(x=0.1 + i * 0.01, y=0.2 + i * 0.005, timestamp=i * 20,
             dx=i * scale, dy=i * scale, velocity=scale, angle=0)
        for i in range(32)
    ]


def page(events=(), url="https://example.test/login", **kwargs):
    payload = dict(url=url, domain=url.split("/")[2].split("@")[-1], domEvents=list(events), hasCredentialField=True)
    payload.update(kwargs)
    return prepare_page_context(payload, prepare_trajectory(points()), False)


def trap(identity, control):
    return dict(evidenceId=identity, evidenceSource="topology_scan", isZeroOpacity=True,
                isHitTestIntercepting=True, coveredControlType=control, elementSelector="div",
                isPasswordInput=False, isCrossOriginIframe=False, isPasteIntoPassword=False)


def test_pixel_channels_do_not_leak_into_model_features():
    left, right = prepare_trajectory(points(1)), prepare_trajectory(points(1280))
    assert left.available and left.valid_point_count == 32
    np.testing.assert_array_equal(left.tensor, right.tensor)
    np.testing.assert_array_equal(left.tensor[0, 2:], [0, 0, 0, 0])


def test_sparse_invalid_and_interpolated_sequences():
    assert not prepare_trajectory([]).available
    one = prepare_trajectory([dict(x=0.3, y=0.4, timestamp=10)])
    np.testing.assert_allclose(one.tensor[:, :2], np.tile([0.3, 0.4], (128, 1)), atol=1e-6)
    assert not one.available
    assert prepare_trajectory([dict(x=0.3, y=0.4, timestamp=float("nan"))]).invalid_reason == "invalid_point"
    assert prepare_trajectory([dict(x=0.3, y=0.4, timestamp=10), dict(x=0.5, y=0.6, timestamp=9)]).invalid_reason == "backward_timestamp"
    two = prepare_trajectory([dict(x=0, y=0, timestamp=0), dict(x=1, y=1, timestamp=100)])
    assert two.tensor[64, 0] == pytest.approx(64 / 127)


def test_neutral_context_and_repeated_traps():
    neutral = dict(isZeroOpacity=True, isCrossOriginIframe=True, isPasswordInput=True,
                   isPasteIntoPassword=True, elementSelector="div")
    assert evaluate_evidence_risk(page([neutral] * 20))["score"] == 0.05
    assert evaluate_evidence_risk(page([trap("a", "submit")] * 20))["score"] == 0.4
    assert evaluate_evidence_risk(page([trap("a", "password"), trap("b", "submit")]))["score"] == 0.9


def test_url_boundaries_and_mentions():
    assert evaluate_evidence_risk(page(url="https://example.test/google?user=a@b.test"))["score"] == 0.05
    assert page(url="https://login.yahoo.com/login")["context"][1] == 0
    assert page(url="https://microsoft.com.evil.test/login")["context"][1] == 1
    assert page(url="https://pineapple.test/login")["context"][1] == 0
    assert evaluate_evidence_risk(page(url="https://google.com@evil.test/login"))["score"] == 0.9
    assert not page(domain="other.test")["available"]


@pytest.mark.parametrize(("score", "action"), [(0.149999, "SAFE"), (0.15, "AMBIGUOUS"), (0.85, "AMBIGUOUS"), (0.850001, "BLOCK")])
def test_model_only_routing_boundaries(score, action):
    assert compose_risk(score, 0.05) == (score, action)
    assert compose_risk(float("nan"), 0.05) == (0.05, "SAFE")

"""Tests for cloud vision: brand matching, fusion, privacy and schema limits (stub embedder, no network)."""

import base64
import io
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image, ImageDraw
from starlette.testclient import TestClient

from phishguard_types import EscalationPayload
from phishguard_backend.db import get_db
from phishguard_backend.main import app
from phishguard_backend.services.cache import reputation_cache
from phishguard_backend.services.cloud_inference import cloud_dispatcher
from phishguard_backend.services.evidence_policy import cloud_evidence_snapshot, compose_cloud_verdict
from phishguard_backend.services.vision import (
    InvalidScreenshotError,
    VisionAnalyzer,
    VisionMatch,
    decode_data_url,
)

PAYPAL_BLUE = (0, 48, 135)
GOOGLE_RED = (219, 68, 55)


def stub_embedder(batch: np.ndarray) -> np.ndarray:
    """Mean colour per 4x4 grid cell: enough structure for cosine matching of solid-colour fixtures."""
    n, c, h, w = batch.shape
    cells = batch.reshape(n, c, 4, h // 4, 4, w // 4).mean(axis=(3, 5))
    return cells.reshape(n, -1)


def data_url(color, fmt="WEBP", size=(64, 64)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    mime = "webp" if fmt == "WEBP" else "jpeg"
    return f"data:image/{mime};base64,{base64.b64encode(buffer.getvalue()).decode()}"


@pytest.fixture
def gallery(tmp_path: Path) -> Path:
    for brand, color in (("paypal", PAYPAL_BLUE), ("google", GOOGLE_RED)):
        brand_dir = tmp_path / brand
        brand_dir.mkdir()
        Image.new("RGB", (64, 64), color).save(brand_dir / "synthetic_1.png")
    return tmp_path


@pytest.fixture
def stub_vision(gallery, monkeypatch):
    analyzer = VisionAnalyzer(gallery_dir=gallery, embedder=stub_embedder)
    monkeypatch.setattr(cloud_dispatcher, "vision_analyzer", analyzer)
    return analyzer


class FakeSession:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        return None

    async def rollback(self):
        return None


@pytest.fixture
def audit_session():
    session = FakeSession()

    async def override():
        yield session

    app.dependency_overrides[get_db] = override
    yield session
    app.dependency_overrides.pop(get_db, None)


client = TestClient(app)


def escalation(domain: str, screenshot=None, client_risk=0.5, has_credential=False) -> dict:
    reputation_cache.clear()
    body = {
        "telemetryId": str(uuid4()),
        "url": f"https://{domain}/login",
        "domain": domain,
        "clientRiskScore": client_risk,
        "hasCredentialField": has_credential,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    if screenshot is not None:
        body["screenshotBase64"] = screenshot
    return body


def test_paypal_lookalike_screenshot_is_blocked(stub_vision, audit_session):
    shot = data_url(PAYPAL_BLUE)
    res = client.post("/v1/escalate", json=escalation("paypal-login-verify.xyz", shot, has_credential=True))

    assert res.status_code == 200
    data = res.json()
    assert data["actionOverride"] == "BLOCK"
    assert data["isPhishing"] is True
    assert data["targetBrand"] == "paypal"
    assert data["teacherModelVersion"] == "cloud-evidence-v2"
    assert any("consented screenshot resembles a brand login" in r for r in data["explanationReasons"])
    assert shot not in res.text, "the response must not echo the screenshot"

    assert len(audit_session.added) == 1
    record = audit_session.added[0]
    for column in record.__table__.columns:
        assert "data:image" not in str(getattr(record, column.name))
    assert not hasattr(record, "screenshot")


def test_vision_alone_cannot_force_a_block(stub_vision, audit_session):
    res = client.post("/v1/escalate", json=escalation("login-verify-paypa1.xyz", data_url(PAYPAL_BLUE), client_risk=0.1))
    assert res.status_code == 200
    data = res.json()
    assert data["actionOverride"] != "BLOCK"
    assert data["targetBrand"] is None
    assert any("Visual resemblance alone does not establish phishing" in r for r in data["explanationReasons"])


def vision_decision(match: VisionMatch) -> dict:
    payload = EscalationPayload(
        telemetryId=uuid4(),
        url="https://lookalike.example/login",
        domain="lookalike.example",
        clientRiskScore=0.1,
        screenshotBase64="data:image/webp;base64,AA==",
        clientTimestamp=datetime.now(timezone.utc),
    )
    return compose_cloud_verdict(cloud_evidence_snapshot(payload), None, match)


def test_vision_match_uses_the_authoritative_thresholds_and_margins():
    """A brand match counts only when it is strong and clearly better than generic logins and other brands."""
    confident = vision_decision(VisionMatch("paypal", 0.95, runner_up_similarity=0.80, generic_similarity=0.80))
    assert "Visual resemblance alone does not establish phishing" in confident["reasons"]
    for match in (
        VisionMatch("paypal", 0.79, 0.30, 0.30),
        VisionMatch("paypal", 0.95, 0.80, 0.91),
        VisionMatch("paypal", 0.95, 0.93, 0.80),
    ):
        assert "Visual resemblance alone does not establish phishing" not in vision_decision(match)["reasons"]


def test_matching_brand_on_its_legit_domain_is_not_flagged(stub_vision, audit_session):
    res = client.post("/v1/escalate", json=escalation("www.paypal.com", data_url(PAYPAL_BLUE), client_risk=0.1))
    assert res.status_code == 200
    data = res.json()
    assert data["targetBrand"] is None
    assert not any("visually matches" in r for r in data["explanationReasons"])


def test_without_screenshot_behaviour_is_unchanged(stub_vision, audit_session):
    res = client.post("/v1/escalate", json=escalation("quiet-example-site.org"))
    assert res.status_code == 200
    data = res.json()
    assert data["teacherModelVersion"] == "cloud-evidence-v2"
    assert not any("visually matches" in r for r in data["explanationReasons"])


def test_vision_errors_degrade_to_no_vision(monkeypatch, audit_session):
    def broken(_batch):
        raise RuntimeError("embedder exploded")

    monkeypatch.setattr(cloud_dispatcher, "vision_analyzer", VisionAnalyzer(embedder=broken))
    res = client.post("/v1/escalate", json=escalation("degraded-vision-site.org", data_url(PAYPAL_BLUE)))
    assert res.status_code == 200
    assert res.json()["teacherModelVersion"] == "cloud-evidence-v2"


def test_oversized_and_wrong_mime_screenshots_return_422(audit_session):
    oversized = "data:image/webp;base64," + "A" * 2_100_000
    res = client.post("/v1/escalate", json=escalation("oversized-shot.org", oversized))
    assert res.status_code == 422
    assert "AAAAAAAA" not in res.text, "validation errors must not echo the screenshot"

    png = "data:image/png;base64,iVBORw0KGgo="
    assert client.post("/v1/escalate", json=escalation("wrong-mime.org", png)).status_code == 422


def test_decode_accepts_full_viewport_jpeg_at_the_dimension_limit():
    image = decode_data_url(data_url((10, 10, 10), fmt="JPEG", size=(2048, 1152)))
    assert image.size == (2048, 1152)


def test_decode_rejects_large_dimensions_and_bad_payloads():
    with pytest.raises(InvalidScreenshotError):
        decode_data_url(data_url((10, 10, 10), size=(2049, 8)))
    with pytest.raises(InvalidScreenshotError):
        decode_data_url("data:image/webp;base64,@@@@")
    with pytest.raises(InvalidScreenshotError):
        decode_data_url("data:image/webp;base64," + base64.b64encode(b"not an image").decode())
    assert decode_data_url(data_url((1, 2, 3), fmt="JPEG")).size == (64, 64)


def test_analyzer_returns_top_match_and_none_for_empty_gallery(gallery, tmp_path_factory):
    analyzer = VisionAnalyzer(gallery_dir=gallery, embedder=stub_embedder)
    top = analyzer.match(data_url(GOOGLE_RED))
    assert top is not None and top.brand == "google" and top.similarity > 0.99
    assert top.runner_up_similarity < top.similarity
    assert top.generic_similarity == 0.0

    empty = VisionAnalyzer(gallery_dir=tmp_path_factory.mktemp("empty"), embedder=stub_embedder)
    assert empty.match(data_url(GOOGLE_RED)) is None


def _mobilenet_weights_cached() -> bool:
    try:
        import torch
        import torchvision  # noqa: F401
    except ImportError:
        return False
    checkpoints = Path(torch.hub.get_dir()) / "checkpoints"
    return checkpoints.is_dir() and any(checkpoints.glob("mobilenet_v3_small-*.pth"))


@pytest.mark.skipif(not _mobilenet_weights_cached(), reason="MobileNetV3-Small weights are not cached locally")
def test_real_mobilenet_embeds_576_dimensions_and_matches_gallery():
    analyzer = VisionAnalyzer()
    embedding = analyzer.embed(data_url((200, 40, 40)))
    assert embedding.shape == (576,)
    assert abs(float(np.linalg.norm(embedding)) - 1.0) < 1e-4
    match = analyzer.match(data_url((200, 40, 40)))
    assert match is not None and 0.0 <= match.similarity <= 1.0


def test_generic_folder_is_a_negative_class_excluded_from_brand_ranking(gallery):
    generic_dir = gallery / "_generic"
    generic_dir.mkdir()
    Image.new("RGB", (64, 64), PAYPAL_BLUE).save(generic_dir / "synthetic_1.png")
    analyzer = VisionAnalyzer(gallery_dir=gallery, embedder=stub_embedder)
    match = analyzer.match(data_url(PAYPAL_BLUE))
    assert match is not None and match.brand == "paypal"
    assert match.generic_similarity > 0.99
    assert "Visual resemblance alone does not establish phishing" not in vision_decision(match)["reasons"]


REAL_GALLERY = Path(__file__).resolve().parents[1] / "assets" / "brand_gallery"


def _png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP")
    return f"data:image/webp;base64,{base64.b64encode(buffer.getvalue()).decode()}"


@pytest.mark.skipif(not _mobilenet_weights_cached(), reason="MobileNetV3-Small weights are not cached locally")
def test_real_embedder_does_not_flag_generic_logins_but_matches_gallery_brands():
    analyzer = VisionAnalyzer()

    plain = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(plain)
    draw.rectangle([60, 80, 196, 180], outline="gray")
    draw.text((70, 90), "Sign in to Acme", fill="black")

    blue = Image.new("RGB", (256, 256), (245, 247, 250))
    draw = ImageDraw.Draw(blue)
    draw.rectangle([40, 60, 216, 200], fill="white", outline=(200, 200, 200))
    draw.rectangle([60, 150, 196, 170], fill=(0, 112, 186))
    draw.text((60, 70), "Log in", fill="black")

    for name, image in (("plain", plain), ("blue_button", blue)):
        match = analyzer.match(_png_data_url(image))
        assert match is not None
        decision = vision_decision(match)
        assert decision["action"] != "BLOCK", name
        assert decision["target_brand"] is None

    for brand, n in (("paypal", 2), ("amazon", 3), ("bankofamerica", 1)):
        with Image.open(REAL_GALLERY / brand / f"synthetic_{n}.png") as image:
            match = analyzer.match(_png_data_url(image.convert("RGB")))
        assert match is not None and match.brand == brand
        decision = vision_decision(match)
        assert decision["action"] != "BLOCK"
        assert decision["target_brand"] is None

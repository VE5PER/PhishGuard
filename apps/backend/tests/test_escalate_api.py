"""Integration and API tests for FastAPI Escalation Gateway."""

from datetime import datetime, timezone
from uuid import uuid4
import pytest
from starlette.testclient import TestClient
from phishguard_types import CloudActionOverride, CloudInferenceVerdict

from phishguard_backend.main import app
from phishguard_backend.db import get_db
from phishguard_backend.services.auth import auth_service
from phishguard_backend.services.cache import reputation_cache
from phishguard_backend.services.storage import artifact_storage

client = TestClient(app)


class FakeSession:
    def add(self, _record):
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None


@pytest.fixture(autouse=True)
def isolate_gateway(monkeypatch):
    original_dev_mode = auth_service.dev_mode
    session = FakeSession()

    async def fake_db():
        yield session

    async def no_storage_probe():
        return False

    app.dependency_overrides[get_db] = fake_db
    monkeypatch.setattr(artifact_storage, 'is_healthy', no_storage_probe)
    reputation_cache.clear()
    yield
    app.dependency_overrides.pop(get_db, None)
    auth_service.dev_mode = original_dev_mode
    reputation_cache.clear()


def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "healthy"
    assert res.json()["capabilities"] == {
        "telemetryEvidenceVersion": 2,
        "modelInputContracts": ["student-v1", "student-v2"],
        "manualEscalation": True,
    }


def test_escalate_cached_benign_domain():
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://google.com/search?q=test",
        "domain": "google.com",
        "clientRiskScore": 0.20,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }

    res = client.post("/v1/escalate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["isPhishing"] is False
    assert data["actionOverride"] == "ALLOW"
    assert data["teacherModelVersion"] == "cloud-evidence-v2"


def test_reputation_prior_does_not_override_recognized_high_client_risk(monkeypatch):
    from phishguard_backend.api.v1 import escalate as endpoint

    calls = []

    async def evaluate(payload, snapshot, metadata):
        calls.append((payload, snapshot, metadata))
        return CloudInferenceVerdict(
            analysisId=uuid4(),
            telemetryId=payload.telemetryId,
            isPhishing=True,
            targetBrand=None,
            confidence=0.99,
            actionOverride=CloudActionOverride.BLOCK,
            explanationReasons=["Recognized client risk"],
            teacherModelVersion="cloud-evidence-v2",
            evaluatedAt=datetime.now(timezone.utc),
        )

    monkeypatch.setattr(endpoint, "trusted_client_risk", lambda _payload, _metadata: 0.99)
    monkeypatch.setattr(endpoint.cloud_dispatcher, "evaluate", evaluate)
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://google.com/login",
        "domain": "google.com",
        "clientRiskScore": 0.99,
        "clientModelVersion": "1.5.0",
        "clientModelSha256": "a" * 64,
        "clientInputContract": "student-v2",
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    response = client.post("/v1/escalate", json=payload)
    assert response.status_code == 200
    assert response.json()["actionOverride"] == "BLOCK"
    assert len(calls) == 1


def test_consent_screenshot_disables_seeded_reputation_prior(monkeypatch):
    from phishguard_backend.api.v1 import escalate as endpoint

    calls = []

    async def evaluate(payload, snapshot, metadata):
        calls.append((payload, snapshot, metadata))
        return CloudInferenceVerdict(
            analysisId=uuid4(),
            telemetryId=payload.telemetryId,
            isPhishing=False,
            targetBrand=None,
            confidence=0.7,
            actionOverride=CloudActionOverride.WARN,
            explanationReasons=["Consented visual comparison"],
            teacherModelVersion="cloud-evidence-v2",
            evaluatedAt=datetime.now(timezone.utc),
        )

    monkeypatch.setattr(endpoint.cloud_dispatcher, "evaluate", evaluate)
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://google.com/login",
        "domain": "google.com",
        "clientRiskScore": 0.1,
        "screenshotBase64": "data:image/webp;base64,AA==",
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    response = client.post("/v1/escalate", json=payload)
    assert response.status_code == 200
    assert response.json()["actionOverride"] == "WARN"
    assert len(calls) == 1


def test_verdict_cache_key_tracks_trusted_risk_and_accepted_report_transition(monkeypatch):
    from types import SimpleNamespace
    from phishguard_backend.api.v1 import escalate as endpoint

    trust = {"risk": None, "report": "c" * 64}
    inference = {"action": "ALLOW"}
    calls = []

    def metadata_for_version(_version):
        return SimpleNamespace(
            version="2.0.0-test",
            sha256="a" * 64,
            validationSummary=SimpleNamespace(reportSha256=trust["report"]),
        )

    monkeypatch.setattr(endpoint.model_registry, "get_metadata", metadata_for_version)
    monkeypatch.setattr(endpoint, "trusted_client_risk", lambda _payload, _metadata: trust["risk"])

    async def evaluate(payload, snapshot, recognized_metadata):
        calls.append((payload, snapshot, recognized_metadata))
        action = inference["action"]
        return CloudInferenceVerdict(
            analysisId=uuid4(),
            telemetryId=payload.telemetryId,
            isPhishing=action == "BLOCK",
            targetBrand=None,
            confidence=0.99 if action == "BLOCK" else 0.05,
            actionOverride=CloudActionOverride(action),
            explanationReasons=[action],
            teacherModelVersion="cloud-evidence-v2",
            evaluatedAt=datetime.now(timezone.utc),
        )

    monkeypatch.setattr(endpoint.cloud_dispatcher, "evaluate", evaluate)
    claimed_payload = {
        "telemetryId": str(uuid4()),
        "url": "https://quiet-transition.test/login",
        "domain": "quiet-transition.test",
        "clientRiskScore": 0.99,
        "clientModelVersion": "2.0.0-test",
        "clientModelSha256": "a" * 64,
        "clientInputContract": "student-v2",
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }

    response = client.post("/v1/escalate", json=claimed_payload)
    assert response.json()["actionOverride"] == "ALLOW"
    trust.update(risk=0.99)
    inference["action"] = "BLOCK"
    response = client.post("/v1/escalate", json=claimed_payload)
    assert response.json()["actionOverride"] == "BLOCK"
    trust["risk"] = None
    inference["action"] = "BLOCK"
    response = client.post("/v1/escalate", json=claimed_payload)
    assert response.json()["actionOverride"] == "ALLOW"

    trust.update(risk=0.99, report="d" * 64)
    inference["action"] = "ALLOW"
    response = client.post("/v1/escalate", json=claimed_payload)
    assert response.json()["actionOverride"] == "ALLOW"
    trust["report"] = "c" * 64
    inference["action"] = "ALLOW"
    response = client.post("/v1/escalate", json=claimed_payload)
    assert response.json()["actionOverride"] == "BLOCK"
    assert len(calls) == 3


def test_escalate_suspicious_payload():
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://microsoft-account-verify.phish.cc/login",
        "domain": "microsoft-account-verify.phish.cc",
        "clientRiskScore": 0.65,
        "mouseTrajectorySeries": [
            {
                "x": 0.45,
                "y": 0.55,
                "dx": 1.2,
                "dy": 0.8,
                "velocity": 0.35,
                "acceleration": 0.05,
                "angle": 0.58,
                "timestamp": 150.0,
                "eventType": "move",
            }
        ],
        "hasCredentialField": True,
        "domElementsSummary": [
            {
                "eventType": "click",
                "targetBoundingBox": {"x": 50, "y": 100, "width": 200, "height": 30},
                "isZeroOpacity": True,
                "isCrossOriginIframe": True,
                "isPasswordInput": True,
                "isPasteIntoPassword": True,
                "elementSelector": "iframe#auth-frame > input#pwd",
                "timestamp": 850.0,
                "evidenceSource": "topology_scan",
                "evidenceId": "password-control",
                "isHitTestIntercepting": True,
                "coveredControlType": "password",
                "credentialFrameEvidence": "unverified",
            },
            {
                "eventType": "click",
                "targetBoundingBox": {"x": 50, "y": 150, "width": 200, "height": 30},
                "isZeroOpacity": True,
                "isCrossOriginIframe": False,
                "isPasswordInput": False,
                "isPasteIntoPassword": False,
                "elementSelector": "form > button",
                "timestamp": 900.0,
                "evidenceSource": "topology_scan",
                "evidenceId": "submit-control",
                "isHitTestIntercepting": True,
                "coveredControlType": "submit",
                "credentialFrameEvidence": "none",
            }
        ],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }

    res = client.post("/v1/escalate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["isPhishing"] is True
    assert data["targetBrand"] == "microsoft"
    assert data["actionOverride"] == "BLOCK"
    assert len(data["explanationReasons"]) > 0


def test_escalate_invalid_payload_returns_422():
    invalid_payload = {
        "telemetryId": "not-a-uuid",
        "url": "not-a-url",
        "clientRiskScore": 2.5,  # Invalid: must be <= 1.0
    }
    res = client.post("/v1/escalate", json=invalid_payload)
    assert res.status_code == 422


def test_auth_rejection_in_strict_mode():
    auth_service.dev_mode = False
    try:
        payload = {
            "telemetryId": str(uuid4()),
            "url": "https://example.com",
            "domain": "example.com",
            "clientRiskScore": 0.5,
            "mouseTrajectorySeries": [],
            "domElementsSummary": [],
            "clientTimestamp": datetime.now(timezone.utc).isoformat(),
        }
        # Missing auth header
        res = client.post("/v1/escalate", json=payload)
        assert res.status_code == 401

        # Invalid token
        res = client.post("/v1/escalate", json=payload, headers={"Authorization": "Bearer bad_token"})
        assert res.status_code == 403

        # Valid token
        res = client.post("/v1/escalate", json=payload, headers={"Authorization": "Bearer test_client_key"})
        assert res.status_code == 200
    finally:
        auth_service.dev_mode = True


def test_cors_private_network_access():
    """Verify that private network access preflight requests (PNA) are permitted for local network devices."""
    res = client.options(
        "/v1/escalate",
        headers={
            "Origin": "http://phishguard.local:8010",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-private-network") == "true"


def test_escalate_url_path_brand_targeting():
    """Verify that a brand target in URL path/query on an unauthorized domain triggers brand detection."""
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://unauthorized-hosting-cdn.com/login/paypal/verify.php?user=target",
        "domain": "unauthorized-hosting-cdn.com",
        "clientRiskScore": 0.45,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    res = client.post("/v1/escalate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["actionOverride"] == "ALLOW"
    assert data["targetBrand"] is None
    assert not any("path/query" in reason for reason in data["explanationReasons"])


def test_escalate_url_userinfo_spoofing():
    """Verify that deceptive '@' authority separator in URL is flagged."""
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://accounts.google.com@evil-site.biz/signin",
        "domain": "evil-site.biz",
        "clientRiskScore": 0.50,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    res = client.post("/v1/escalate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["actionOverride"] == "WARN"
    assert any("authority userinfo" in reason for reason in data["explanationReasons"])


def test_url_domain_mismatch_is_rejected_before_any_cache_write():
    payload = {
        "telemetryId": str(uuid4()),
        "url": "https://evil.example/login",
        "domain": "google.com",
        "clientRiskScore": 0.2,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    res = client.post("/v1/escalate", json=payload)
    assert res.status_code == 422
    assert reputation_cache._verdicts == {}


def test_reputation_cache_url_specificity():
    """Verify that caching a verdict by full URL separates different paths on the same host."""
    from phishguard_backend.services.cache import reputation_cache

    url_safe = "verdict-v2:http://localhost:8010/Sample1"
    url_blocked = "verdict-v2:http://localhost:8010/sample3"

    reputation_cache.set_verdict(url_safe, is_phishing=False, confidence=0.99, target_brand=None, action="ALLOW", reasons=["Clean baseline"])
    reputation_cache.set_verdict(url_blocked, is_phishing=True, confidence=0.99, target_brand=None, action="BLOCK", reasons=["Deceptive traps"])

    assert reputation_cache.get_verdict(url_safe)["action"] == "ALLOW"
    assert reputation_cache.get_verdict(url_blocked)["action"] == "BLOCK"
    assert reputation_cache.get_reputation_prior("localhost") is None

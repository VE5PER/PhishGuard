"""POST /v1/escalate/gemini contract, audit, cache namespacing and fallback behaviour."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from phishguard_types import CloudInferenceVerdict
from starlette.testclient import TestClient

from phishguard_backend.db import EscalationAuditRecord, get_db
from phishguard_backend.main import app
from phishguard_backend.services.cache import reputation_cache
from phishguard_backend.services.gemini_agent import gemini_teacher
from phishguard_backend.services.rate_limit import gemini_escalate_limiter

client = TestClient(app)
GEMINI_VERSION = "gemini-adk/gemini-3.5-flash-lite"


class RecordingSession:
    def __init__(self):
        self.added = []

    def add(self, record):
        self.added.append(record)

    async def commit(self):
        return None

    async def rollback(self):
        return None


@pytest.fixture
def session():
    recording = RecordingSession()

    async def fake_db():
        yield recording

    app.dependency_overrides[get_db] = fake_db
    reputation_cache.clear()
    yield recording
    app.dependency_overrides.pop(get_db, None)
    reputation_cache.clear()


@pytest.fixture
def stub_agent(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")
    state = SimpleNamespace(calls=[], result=json.dumps(
        dict(is_phishing=True, target_brand="paypal", confidence=0.95, action="BLOCK", reasons=["Lookalike host"], risk_score=0.95)
    ))

    async def run_agent(content, call_state):
        state.calls.append(call_state)
        if isinstance(state.result, BaseException):
            raise state.result
        return state.result, []

    monkeypatch.setattr(gemini_teacher, "_run_agent", run_agent)
    return state


def payload(host="paypa1.xyz"):
    return {
        "telemetryId": str(uuid4()),
        "url": f"https://{host}/login",
        "domain": host,
        "clientRiskScore": 0.5,
        "hasCredentialField": True,
        "mouseTrajectorySeries": [],
        "domElementsSummary": [],
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }


def test_contract_and_audit_row(session, stub_agent):
    body = payload()
    response = client.post("/v1/escalate/gemini", json=body)
    assert response.status_code == 200
    verdict = CloudInferenceVerdict.model_validate(response.json())
    assert verdict.teacherModelVersion == GEMINI_VERSION and verdict.telemetryId.hex == body["telemetryId"].replace("-", "")
    assert len(session.added) == 1
    record = session.added[0]
    assert isinstance(record, EscalationAuditRecord) and record.teacher_model_version == GEMINI_VERSION


def test_audit_commit_failure_never_fails_verdict(session, stub_agent, monkeypatch):
    async def failing_commit():
        raise RuntimeError("db down")

    monkeypatch.setattr(session, "commit", failing_commit)
    for path in ("/v1/escalate", "/v1/escalate/gemini"):
        response = client.post(path, json=payload())
        assert response.status_code == 200
        CloudInferenceVerdict.model_validate(response.json())
    assert len(session.added) == 2


def test_invalid_payload_and_mismatched_domain(session, stub_agent):
    assert client.post("/v1/escalate/gemini", json={"url": "x"}).status_code == 422
    bad = payload()
    bad["domain"] = "other.test"
    assert client.post("/v1/escalate/gemini", json=bad).status_code == 422
    assert stub_agent.calls == []


def test_gemini_cache_hit_skips_teacher(session, stub_agent):
    body = payload()
    first = client.post("/v1/escalate/gemini", json=body).json()
    second = client.post("/v1/escalate/gemini", json=body).json()
    assert first["teacherModelVersion"] == second["teacherModelVersion"] == GEMINI_VERSION
    assert len(stub_agent.calls) == 1


def test_baseline_cache_never_shadows_gemini(session, stub_agent, monkeypatch):
    body = payload()
    monkeypatch.delenv("GEMINI_API_KEY")
    assert client.post("/v1/escalate", json=body).json()["teacherModelVersion"] == "cloud-evidence-v2"
    assert stub_agent.calls == []
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")
    assert client.post("/v1/escalate", json=body).json()["teacherModelVersion"] == GEMINI_VERSION
    assert client.post("/v1/escalate/gemini", json=body).json()["teacherModelVersion"] == GEMINI_VERSION
    assert len(stub_agent.calls) == 1


def test_fallback_not_cached(session, stub_agent):
    body = payload()
    stub_agent.result = RuntimeError("boom")
    assert client.post("/v1/escalate/gemini", json=body).json()["teacherModelVersion"].endswith("-fallback")
    stub_agent.result = json.dumps(
        dict(is_phishing=False, target_brand=None, confidence=0.9, action="WARN", reasons=["Looks odd"], risk_score=0.5)
    )
    assert client.post("/v1/escalate/gemini", json=body).json()["teacherModelVersion"] == GEMINI_VERSION
    assert len(stub_agent.calls) == 2


def test_unconfigured_returns_fallback_and_audits(session):
    verdict = client.post("/v1/escalate/gemini", json=payload()).json()
    assert verdict["teacherModelVersion"] == "cloud-evidence-v2-fallback"
    assert session.added[0].teacher_model_version == "cloud-evidence-v2-fallback"


def test_rate_limit_429(session):
    codes = [client.post("/v1/escalate/gemini", json=payload()).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429
    gemini_escalate_limiter.reset()

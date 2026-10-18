"""Playground scenario and run API tests (Gemini always stubbed, no network)."""

import base64
import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image
from phishguard_types import EscalationPayload, PlaygroundRunResponse, PlaygroundScenarioList
from starlette.testclient import TestClient

from phishguard_backend.db import get_db
from phishguard_backend.main import app
from phishguard_backend.services.cache import reputation_cache
from phishguard_backend.services.gemini_agent import gemini_teacher
from phishguard_backend.services.model_registry import model_registry
from phishguard_backend.services.rate_limit import playground_run_limiter

client = TestClient(app)
SCENARIO_IDS = ["brand-impersonation", "ambiguous-sso", "benign-google"]
GEMINI_BLOCK = json.dumps(
    dict(is_phishing=True, target_brand="paypal", confidence=0.95, action="BLOCK", reasons=["Lookalike host"], risk_score=0.95)
)


class RecordingSession:
    def __init__(self):
        self.added = []

    def add(self, record):
        self.added.append(record)


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
    calls = []

    async def run_agent(content, state):
        calls.append(state)
        return GEMINI_BLOCK, []

    monkeypatch.setattr(gemini_teacher, "_run_agent", run_agent)
    return SimpleNamespace(calls=calls)


def test_scenarios_listing_validates_and_fits_limits(session):
    body = client.get("/v1/playground/scenarios").json()
    listing = PlaygroundScenarioList.model_validate(body)
    assert [s.id for s in listing.scenarios] == SCENARIO_IDS
    assert listing.geminiConfigured is False and listing.geminiModel is None
    for scenario in body["scenarios"]:
        EscalationPayload.model_validate(scenario["payload"])
        data_url = scenario["payload"]["screenshotBase64"]
        assert len(data_url) < 400_000
        image = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))
        assert max(image.size) <= 1024


def test_scenarios_listing_reports_configured_gemini(session, stub_agent):
    body = client.get("/v1/playground/scenarios").json()
    assert body["geminiConfigured"] is True and body["geminiModel"] == "gemini-3.5-flash-lite"


def test_run_unconfigured_gemini_falls_back(session):
    response = client.post("/v1/playground/scenarios/brand-impersonation/run", json={"clientRiskScore": 0.2784})
    assert response.status_code == 200
    run = PlaygroundRunResponse.model_validate(response.json())
    assert run.payload.clientRiskScore == 0.278
    assert run.evidence.verdict.teacherModelVersion == "cloud-evidence-v2"
    assert run.evidence.verdict.actionOverride.value == "BLOCK"
    assert run.gemini.trace.status.value == "unconfigured"
    assert run.gemini.verdict.teacherModelVersion == "cloud-evidence-v2-fallback"
    assert run.evidence.latencyMs >= 0 and run.gemini.latencyMs >= 0
    assert session.added == []


def test_run_with_gemini_and_cache(session, stub_agent):
    path = "/v1/playground/scenarios/brand-impersonation/run"
    first = PlaygroundRunResponse.model_validate(client.post(path, json={"clientRiskScore": 0.3}).json())
    assert first.gemini.trace.status.value == "ok" and first.gemini.cached is False
    assert first.gemini.verdict.teacherModelVersion == "gemini-adk/gemini-3.5-flash-lite"
    assert first.evidence.cached is False
    second = PlaygroundRunResponse.model_validate(client.post(path, json={"clientRiskScore": 0.3}).json())
    assert second.gemini.cached is True and second.evidence.cached is True
    assert second.gemini.trace.cached is True and second.gemini.trace.toolCalls == []
    assert len(stub_agent.calls) == 1
    assert session.added == []


def test_gemini_allow_cannot_clear_evidence_backed_warn(session, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")
    allow = json.dumps(
        dict(is_phishing=False, target_brand=None, confidence=0.9, action="ALLOW", reasons=["Looks fine"], risk_score=0.1)
    )

    async def run_agent(content, state):
        return allow, []

    monkeypatch.setattr(gemini_teacher, "_run_agent", run_agent)
    response = client.post("/v1/playground/scenarios/ambiguous-sso/run", json={"clientRiskScore": 0.3})
    assert response.status_code == 200
    run = PlaygroundRunResponse.model_validate(response.json())
    assert run.gemini.trace.status.value == "ok"
    assert run.gemini.verdict.actionOverride.value == "WARN"
    assert run.gemini.verdict.isPhishing is False


def test_unknown_scenario_404(session):
    assert client.post("/v1/playground/scenarios/nope/run", json={"clientRiskScore": 0.2}).status_code == 404


@pytest.mark.parametrize("body", [{"clientRiskScore": 0.2, "extra": 1}, {"clientRiskScore": 1.5}, {}])
def test_invalid_body_422(session, body):
    assert client.post("/v1/playground/scenarios/benign-google/run", json=body).status_code == 422


def test_rate_limit_429(session):
    path = "/v1/playground/scenarios/benign-google/run"
    codes = [client.post(path, json={"clientRiskScore": 0.1}).status_code for _ in range(13)]
    assert codes[:12] == [200] * 12 and codes[12] == 429
    playground_run_limiter.reset()
    assert client.post(path, json={"clientRiskScore": 0.1}).status_code == 200


def test_rate_limit_keys_on_first_forwarded_hop(session):
    path = "/v1/playground/scenarios/benign-google/run"
    for _ in range(12):
        assert client.post(path, json={"clientRiskScore": 0.1}, headers={"X-Forwarded-For": "1.1.1.1, 9.9.9.9"}).status_code == 200
    assert client.post(path, json={"clientRiskScore": 0.1}, headers={"X-Forwarded-For": "1.1.1.1"}).status_code == 429
    assert client.post(path, json={"clientRiskScore": 0.1}, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_client_risk_trusted_only_with_matching_model_fields(session, monkeypatch):
    metadata = model_registry.get_metadata("2.0.0")
    assert metadata is not None
    seen = []
    from phishguard_backend.api.v1 import escalate as endpoint

    original = endpoint.trusted_client_risk

    def spy(payload, meta):
        result = original(payload, meta)
        seen.append(result)
        return result

    monkeypatch.setattr(endpoint, "trusted_client_risk", spy)
    path = "/v1/playground/scenarios/ambiguous-sso/run"
    matching = {
        "clientRiskScore": 0.4,
        "clientModelVersion": metadata.version,
        "clientModelSha256": metadata.sha256,
        "clientInputContract": "student-v2",
    }
    assert client.post(path, json=matching).status_code == 200
    reputation_cache.clear()
    assert client.post(path, json={**matching, "clientModelSha256": "0" * 64}).status_code == 200
    reputation_cache.clear()
    assert client.post(path, json={"clientRiskScore": 0.4}).status_code == 200
    assert seen[0] == 0.4 and seen[1] is None and seen[2] is None


def _point(i, x=0.5, y=0.5):
    return {
        "x": x, "y": y, "dx": 0.0, "dy": 0.0, "velocity": 0.0, "acceleration": 0.0,
        "angle": 0.0, "timestamp": float(i * 10), "eventType": "move",
    }


def _observed(**overrides):
    event = {
        "eventType": "focus",
        "targetBoundingBox": {"x": 1, "y": 2, "width": 3, "height": 4},
        "isZeroOpacity": False,
        "isCrossOriginIframe": False,
        "isPasswordInput": True,
        "isPasteIntoPassword": False,
        "elementSelector": "input#user-supplied",
        "timestamp": 10.0,
        "evidenceSource": "observed_interaction",
    }
    event.update(overrides)
    return event


def test_run_with_interaction_merges_user_behavior_and_keeps_server_fixed_fields(session):
    path = "/v1/playground/scenarios/brand-impersonation/run"
    template = client.get("/v1/playground/scenarios").json()["scenarios"][0]["payload"]
    interaction = {
        "mouseTrajectorySeries": [_point(i, 0.1 + i * 0.01, 0.2) for i in range(20)],
        "keystrokesSummary": [{"category": "ALPHANUMERIC", "dwellTimeMs": 90.0, "flightTimeMs": 120.0, "timestamp": 500.0}],
        "observedDomEvents": [_observed()],
    }
    response = client.post(path, json={"clientRiskScore": 0.3, "interaction": interaction})
    assert response.status_code == 200
    payload = PlaygroundRunResponse.model_validate(response.json()).payload
    assert [(p.x, p.y) for p in payload.mouseTrajectorySeries] == [(0.1 + i * 0.01, 0.2) for i in range(20)]
    assert len(payload.keystrokesSummary) == 1 and payload.keystrokesSummary[0].dwellTimeMs == 90.0
    sources = [(e.evidenceSource.value, e.elementSelector) for e in payload.domElementsSummary]
    template_topology = [e["elementSelector"] for e in template["domElementsSummary"] if e["evidenceSource"] == "topology_scan"]
    assert [sel for src, sel in sources if src == "topology_scan"] == template_topology
    assert [sel for src, sel in sources if src == "observed_interaction"] == ["input#user-supplied"]
    assert sources[-1] == ("observed_interaction", "input#user-supplied")
    assert str(payload.url) == template["url"] and payload.domain == template["domain"]
    assert payload.screenshotBase64 == template["screenshotBase64"]
    assert session.added == []


def test_run_with_interaction_drops_fixture_observed_events(session):
    path = "/v1/playground/scenarios/ambiguous-sso/run"
    template = client.get("/v1/playground/scenarios").json()["scenarios"][1]["payload"]
    assert any(e["evidenceSource"] == "observed_interaction" for e in template["domElementsSummary"])
    interaction = {"mouseTrajectorySeries": [_point(0)]}
    payload = PlaygroundRunResponse.model_validate(
        client.post(path, json={"clientRiskScore": 0.3, "interaction": interaction}).json()
    ).payload
    assert all(e.evidenceSource.value == "topology_scan" for e in payload.domElementsSummary)
    assert payload.keystrokesSummary == []


@pytest.mark.parametrize("source", ["topology_scan", "legacy"])
def test_run_rejects_non_observed_events_in_interaction(session, source):
    interaction = {"mouseTrajectorySeries": [_point(0)], "observedDomEvents": [_observed(evidenceSource=source)]}
    response = client.post(
        "/v1/playground/scenarios/benign-google/run", json={"clientRiskScore": 0.1, "interaction": interaction}
    )
    assert response.status_code == 422


def test_run_without_interaction_uses_fixture_behavior(session):
    template = client.get("/v1/playground/scenarios").json()["scenarios"][2]["payload"]
    payload = PlaygroundRunResponse.model_validate(
        client.post("/v1/playground/scenarios/benign-google/run", json={"clientRiskScore": 0.1}).json()
    ).payload
    assert len(payload.mouseTrajectorySeries) == len(template["mouseTrajectorySeries"])
    assert len(payload.domElementsSummary) == len(template["domElementsSummary"])
    assert len(payload.keystrokesSummary) == len(template["keystrokesSummary"])

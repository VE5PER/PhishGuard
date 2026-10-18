"""Gemini ADK forensic teacher: config, evidence brief, tools, rails, fallback, breaker, API."""

import asyncio
import base64
import io
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image
from phishguard_types import CloudInferenceVerdict, EscalationPayload, TeacherTraceStatus
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient

from phishguard_backend.db import Base, EscalationAuditRecord, get_db
from phishguard_backend.main import app
from phishguard_backend.services import gemini_agent
from phishguard_backend.services.cache import reputation_cache
from phishguard_backend.services.cloud_inference import WARN_FLOOR_REASON, apply_safety_rails, cloud_dispatcher
from phishguard_backend.services.evidence_policy import cloud_evidence_snapshot
from phishguard_backend.services.gemini_agent import (
    CircuitBreaker,
    GeminiForensicFinding,
    GeminiTeacherConfig,
    build_content,
    build_evidence_brief,
    circuit_breaker,
    gemini_teacher,
    lookup_threat_memory_bank,
    verify_brand_official_domain,
)

client = TestClient(app)
SCREENSHOT = "data:image/webp;base64,AA=="


def make_payload(host="paypa1.xyz", screenshot=None):
    return EscalationPayload.model_validate(
        {
            "telemetryId": str(uuid4()),
            "url": f"https://{host}/login?token=SECRETVALUE&next=/home#frag-secret",
            "domain": host,
            "clientRiskScore": 0.5,
            "hasCredentialField": True,
            "screenshotBase64": screenshot,
            "mouseTrajectorySeries": [],
            "domElementsSummary": [],
            "clientTimestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def finding_json(**overrides):
    data = dict(is_phishing=True, target_brand="paypal", confidence=0.95, action="BLOCK", reasons=["Lookalike host"], risk_score=0.95)
    data.update(overrides)
    return json.dumps(data)


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")


@pytest.fixture
def stub_agent(monkeypatch):
    calls = []
    behavior = {"result": finding_json(), "tool_calls": []}

    async def run_agent(content, state):
        calls.append(state)
        result = behavior["result"]
        if isinstance(result, BaseException):
            raise result
        if callable(result):
            return await result(), behavior["tool_calls"]
        return result, behavior["tool_calls"]

    monkeypatch.setattr(gemini_teacher, "_run_agent", run_agent)
    return SimpleNamespace(calls=calls, behavior=behavior)


@pytest.fixture
def api():
    class FakeSession:
        def add(self, _record):
            return None

        async def commit(self):
            return None

        async def rollback(self):
            return None

    async def fake_db():
        yield FakeSession()

    app.dependency_overrides[get_db] = fake_db
    reputation_cache.clear()
    yield client
    app.dependency_overrides.pop(get_db, None)
    reputation_cache.clear()


def api_payload(host="paypa1.xyz"):
    return json.loads(make_payload(host).model_dump_json())


def test_config_unset_and_placeholder_not_configured(monkeypatch):
    assert GeminiTeacherConfig.from_env().configured is False
    assert GeminiTeacherConfig.from_env().model == "gemini-3.5-flash-lite"
    monkeypatch.setenv("GEMINI_API_KEY", "CHANGE_ME_GEMINI_API_KEY")
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    assert GeminiTeacherConfig.from_env().configured is False


def test_config_real_key_disabled_and_vertex(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "CHANGE_ME_X")
    monkeypatch.setenv("GOOGLE_API_KEY", "real-google-key")
    config = GeminiTeacherConfig.from_env()
    assert config.configured and config.api_key == "real-google-key"
    assert "real-google-key" not in repr(config)
    monkeypatch.setenv("GEMINI_TEACHER_ENABLED", "false")
    assert GeminiTeacherConfig.from_env().configured is False
    monkeypatch.delenv("GEMINI_TEACHER_ENABLED")
    monkeypatch.delenv("GOOGLE_API_KEY")
    monkeypatch.delenv("GEMINI_API_KEY")
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    assert GeminiTeacherConfig.from_env().configured is False
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "proj")
    monkeypatch.setenv("GEMINI_TEACHER_MODEL", "gemini-x")
    monkeypatch.setenv("GEMINI_TEACHER_TIMEOUT_S", "2.5")
    config = GeminiTeacherConfig.from_env()
    assert config.configured and config.vertex and config.model == "gemini-x" and config.timeout_s == 2.5


def test_evidence_brief_strips_query_values_and_fragment():
    payload = make_payload()
    brief = build_evidence_brief(payload, cloud_evidence_snapshot(payload), None)
    text = json.dumps(brief)
    assert "SECRETVALUE" not in text and "frag-secret" not in text
    assert brief["url"]["query_keys"] == ["token", "next"]
    assert brief["url"]["hostname"] == "paypa1.xyz"
    assert "rule_ids" in brief["deterministic_policy"]
    assert "credential_present" in brief["deterministic_policy"]["page_context"]
    assert brief["screenshot_attached"] is False


def _event(**overrides):
    event = {
        "eventType": "click",
        "targetBoundingBox": {"x": 0.12345, "y": 0.2, "width": 10.0, "height": 5.0},
        "isZeroOpacity": False,
        "isCrossOriginIframe": False,
        "isPasswordInput": False,
        "isPasteIntoPassword": False,
        "elementSelector": "div#secret-selector",
        "timestamp": 1.0,
        "evidenceId": "evid-secret",
    }
    event.update(overrides)
    return event


def test_evidence_brief_dom_elements_excludes_selector_orders_and_caps():
    data = json.loads(make_payload().model_dump_json())
    data["domElementsSummary"] = [_event() for _ in range(45)] + [_event(isZeroOpacity=True, isPasswordInput=True)]
    data["mouseTrajectorySeries"] = [
        {"x": 0.1, "y": 0.1, "dx": 1.0, "dy": 1.0, "velocity": 1.0, "acceleration": -2.0, "angle": 0.0,
         "timestamp": 100.0, "eventType": "move"},
        {"x": 0.2, "y": 0.2, "dx": 1.0, "dy": 1.0, "velocity": 3.0, "acceleration": 1.0, "angle": 0.0,
         "timestamp": 400.0, "eventType": "move"},
    ]
    payload = EscalationPayload.model_validate(data)
    brief = build_evidence_brief(payload, cloud_evidence_snapshot(payload), None)
    elements = brief["dom"]["elements"]
    assert len(elements) == 40
    assert elements[0]["isZeroOpacity"] is True and elements[0]["isPasswordInput"] is True
    assert elements[1]["isZeroOpacity"] is False
    assert elements[0]["bbox"] == {"x": 0.123, "y": 0.2, "width": 10.0, "height": 5.0}
    text = json.dumps(brief)
    assert "secret-selector" not in text and "evid-secret" not in text and "elementSelector" not in text
    assert brief["behavior"]["pointer_acceleration_max"] == 2.0
    assert brief["behavior"]["pointer_acceleration_mean"] == 1.5
    assert brief["behavior"]["pointer_duration_ms"] == 300.0


def test_content_has_image_part_only_with_screenshot():
    payload = make_payload()
    brief = build_evidence_brief(payload, cloud_evidence_snapshot(payload), None)
    assert len(build_content(payload, brief).parts) == 1
    shot = make_payload(screenshot=SCREENSHOT)
    content = build_content(shot, build_evidence_brief(shot, cloud_evidence_snapshot(shot), None))
    assert len(content.parts) == 2
    assert content.parts[1].inline_data.mime_type == "image/webp"


def test_verify_brand_tool():
    context = SimpleNamespace(state={"page_host": "paypa1.xyz"})
    result = verify_brand_official_domain("PayPal", context)
    assert result["known"] is True and result["page_host_authorized"] is False
    assert "paypal.com" in result["authorized_domains"]
    assert verify_brand_official_domain("PayPal", SimpleNamespace(state={"page_host": "www.paypal.com"}))["page_host_authorized"]
    assert verify_brand_official_domain("NoSuchBrandXyz", context)["known"] is False


def test_threat_memory_counts_and_error(monkeypatch, tmp_path):
    asyncio.run(_test_threat_memory_counts_and_error(monkeypatch, tmp_path))


async def _test_threat_memory_counts_and_error(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'audit.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)

    def record(domain, action, brand):
        return EscalationAuditRecord(
            telemetry_id=str(uuid4()), url=f"https://{domain}/", domain=domain, client_risk_score=0.5,
            is_phishing=action == "BLOCK", target_brand=brand, action_override=action,
            explanation_reasons=[], teacher_model_version="v", created_at=now,
        )

    async with factory() as session:
        for action, brand in (("BLOCK", "paypal"), ("BLOCK", "paypal"), ("WARN", None), ("ALLOW", None)):
            session.add(record("evil.test", action, brand))
        session.add(record("other.test", "BLOCK", "apple"))
        await session.commit()
    monkeypatch.setattr(gemini_agent, "threat_memory_session_factory", factory)
    result = await lookup_threat_memory_bank("evil.test")
    assert result["available"] is True
    assert (result["prior_escalations"], result["block_count"], result["warn_count"]) == (4, 2, 1)
    assert result["recent_brands"] == ["paypal"]
    assert (await lookup_threat_memory_bank("unseen.test"))["prior_escalations"] == 0
    await engine.dispose()

    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(gemini_agent, "threat_memory_session_factory", broken)
    assert await lookup_threat_memory_bank("evil.test") == {"available": False}


def test_build_agent_has_tools_and_schema_without_network(configured):
    agent = gemini_teacher.build_agent()
    assert agent.name == "phishguard_sentinel"
    assert len(agent.tools) == 2
    assert agent.output_schema is GeminiForensicFinding
    assert agent.generate_content_config.temperature == 0.0


def test_dispatcher_success_version_and_validity(configured, stub_agent):
    asyncio.run(_test_dispatcher_success_version_and_validity())


async def _test_dispatcher_success_version_and_validity():
    verdict, trace = await cloud_dispatcher.evaluate_with_trace(make_payload())
    CloudInferenceVerdict.model_validate(verdict.model_dump())
    assert trace.status == TeacherTraceStatus.OK
    assert verdict.teacherModelVersion == "gemini-adk/gemini-3.5-flash-lite"
    assert verdict.actionOverride.value == "BLOCK" and verdict.targetBrand == "paypal"


def finding(**overrides):
    return GeminiForensicFinding.model_validate_json(finding_json(**overrides))


def baseline(action="ALLOW", confidence=0.9, brand=None, risk_score=0.05):
    return dict(
        action=action, is_phishing=action == "BLOCK", confidence=confidence, target_brand=brand,
        reasons=["baseline reason"], risk_score=risk_score,
    )


def test_rail_authorized_host_voids_brand_claim():
    result = apply_safety_rails(finding(), baseline(), {"hostname": "www.paypal.com"})
    assert result["action"] == "ALLOW" and result["is_phishing"] is False
    assert any("Brand claim contradicted by registry" in reason for reason in result["reasons"])
    assert "Lookalike host" not in result["reasons"]
    assert "baseline reason" in result["reasons"]


def test_rail_low_confidence_block_becomes_warn():
    result = apply_safety_rails(finding(confidence=0.6), baseline(), {"hostname": "paypa1.xyz"})
    assert result["action"] == "WARN" and result["is_phishing"] is False


def test_rail_baseline_block_never_downgraded():
    result = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand=None, confidence=0.9),
        baseline("BLOCK", 0.97), {"hostname": "paypa1.xyz"},
    )
    assert result["action"] == "BLOCK" and result["is_phishing"] is True and result["confidence"] == 0.97


def test_rail_unauthorized_host_high_confidence_blocks():
    result = apply_safety_rails(finding(confidence=0.95), baseline(), {"hostname": "paypa1.xyz"})
    assert result["action"] == "BLOCK" and result["is_phishing"] is True and result["target_brand"] == "paypal"


def test_rail_warn_floor_blocks_allow_downgrade():
    result = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand=None, confidence=0.9, risk_score=0.1, reasons=["Looks fine"]),
        baseline("WARN", 0.4, risk_score=0.4), {"hostname": "sso.northwind.test"},
    )
    assert result["action"] == "WARN" and result["is_phishing"] is False
    assert result["risk_score"] == 0.4 and result["confidence"] == 0.4
    assert WARN_FLOOR_REASON in result["reasons"] and "baseline reason" in result["reasons"]
    assert result["reasons"][-1] == "Looks fine"


def test_rail_warn_floor_on_authorized_host_keeps_baseline_warn():
    result = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand="paypal", confidence=0.9, risk_score=0.1),
        baseline("WARN", 0.4, risk_score=0.4), {"hostname": "www.paypal.com"},
    )
    assert result["action"] == "WARN" and result["risk_score"] == 0.4


@pytest.mark.parametrize("action,expected", [("WARN", "WARN"), ("BLOCK", "BLOCK")])
def test_rail_warn_floor_leaves_warn_and_block_unchanged(action, expected):
    result = apply_safety_rails(
        finding(action=action, confidence=0.95, risk_score=0.9 if action == "BLOCK" else 0.5),
        baseline("WARN", 0.4, risk_score=0.4), {"hostname": "paypa1.xyz"},
    )
    assert result["action"] == expected
    assert WARN_FLOOR_REASON not in result["reasons"]


@pytest.mark.parametrize("mode", ["error", "timeout", "malformed"])
def test_fallback_on_failure(configured, stub_agent, monkeypatch, mode):
    monkeypatch.setenv("GEMINI_TEACHER_TIMEOUT_S", "0.05")

    async def slow():
        await asyncio.sleep(1)
        return finding_json()

    stub_agent.behavior["result"] = {"error": RuntimeError("boom"), "timeout": slow, "malformed": "not json"}[mode]
    verdict, trace = asyncio.run(cloud_dispatcher.evaluate_with_trace(make_payload()))
    assert trace.status == TeacherTraceStatus.FALLBACK
    assert verdict.teacherModelVersion == "cloud-evidence-v2-fallback"
    assert "Automated fallback applied: cloud AI teacher unavailable" in verdict.explanationReasons


def test_circuit_breaker_unit():
    now = [0.0]
    breaker = CircuitBreaker(failure_threshold=3, cooldown_s=60, clock=lambda: now[0])
    for _ in range(3):
        assert breaker.allow()
        breaker.record_failure()
    assert breaker.state == "open" and not breaker.allow()
    now[0] = 61
    assert breaker.state == "half-open" and breaker.allow() and not breaker.allow()
    breaker.record_failure()
    assert breaker.state == "open"
    now[0] = 130
    assert breaker.allow()
    breaker.record_success()
    assert breaker.state == "closed"


def test_circuit_opens_after_three_failures_and_recovers(configured, stub_agent, monkeypatch):
    asyncio.run(_test_circuit_opens_after_three_failures_and_recovers(configured, stub_agent, monkeypatch))


async def _test_circuit_opens_after_three_failures_and_recovers(configured, stub_agent, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(circuit_breaker, "_clock", lambda: now[0])
    stub_agent.behavior["result"] = RuntimeError("boom")
    for _ in range(4):
        verdict, _trace = await cloud_dispatcher.evaluate_with_trace(make_payload())
        assert verdict.teacherModelVersion == "cloud-evidence-v2-fallback"
    assert len(stub_agent.calls) == 3
    now[0] = 61
    stub_agent.behavior["result"] = finding_json()
    verdict, trace = await cloud_dispatcher.evaluate_with_trace(make_payload())
    assert len(stub_agent.calls) == 4
    assert trace.status == TeacherTraceStatus.OK and verdict.teacherModelVersion.startswith("gemini-adk/")


def test_cancelled_half_open_probe_does_not_leak(configured, stub_agent, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(circuit_breaker, "_clock", lambda: now[0])
    for _ in range(3):
        circuit_breaker.record_failure()
    now[0] = 61
    stub_agent.behavior["result"] = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(cloud_dispatcher.evaluate_with_trace(make_payload()))
    assert len(stub_agent.calls) == 1
    now[0] = 130
    assert circuit_breaker.allow()


def test_cancelled_evaluations_do_not_trip_closed_breaker(configured, stub_agent):
    stub_agent.behavior["result"] = asyncio.CancelledError()
    for _ in range(3):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(cloud_dispatcher.evaluate_with_trace(make_payload()))
    assert len(stub_agent.calls) == 3
    assert circuit_breaker.state == "closed"


def test_health_reports_cloud_teacher():
    body = client.get("/health").json()
    assert body["cloudTeacher"]["configured"] is False
    assert body["cloudTeacher"]["provider"] == "gemini-adk"
    assert body["cloudTeacher"]["circuit"] == "closed"


def test_dispatcher_default_never_consults_teacher(configured, stub_agent):
    verdict = asyncio.run(cloud_dispatcher.evaluate(make_payload()))
    assert verdict.teacherModelVersion == "cloud-evidence-v2"
    assert stub_agent.calls == []


def _trace(payload=None):
    return asyncio.run(cloud_dispatcher.evaluate_with_trace(payload or make_payload()))


def test_trace_unconfigured(stub_agent):
    verdict, trace = _trace()
    assert trace.status.value == "unconfigured" and trace.cached is False and trace.toolCalls == []
    assert verdict.teacherModelVersion == "cloud-evidence-v2-fallback"
    assert stub_agent.calls == []


def test_trace_ok_with_tool_calls(configured, stub_agent):
    from phishguard_types import TeacherToolCall

    stub_agent.behavior["tool_calls"] = [
        TeacherToolCall(name="verify_brand_official_domain", args={"brand_name": "PayPal"}, result={"known": True})
    ]
    verdict, trace = _trace()
    assert trace.status.value == "ok" and trace.model == "gemini-3.5-flash-lite"
    assert trace.toolCalls[0].name == "verify_brand_official_domain"
    assert trace.fallbackReason is None and trace.latencyMs >= 0
    assert verdict.teacherModelVersion == "gemini-adk/gemini-3.5-flash-lite"


def test_trace_fallback_reason_is_exception_type_only(configured, stub_agent):
    stub_agent.behavior["result"] = RuntimeError("secret detail")
    verdict, trace = _trace()
    assert trace.status.value == "fallback" and trace.fallbackReason == "RuntimeError"
    assert "secret detail" not in trace.model_dump_json()


def test_trace_circuit_open(configured, stub_agent):
    stub_agent.behavior["result"] = RuntimeError("boom")
    for _ in range(3):
        _trace()
    verdict, trace = _trace()
    assert trace.status.value == "circuit_open" and len(stub_agent.calls) == 3
    assert verdict.teacherModelVersion == "cloud-evidence-v2-fallback"


def test_trace_budget_exhausted(configured, stub_agent, monkeypatch):
    monkeypatch.setenv("GEMINI_TEACHER_MAX_CALLS_PER_HOUR", "2")
    assert [_trace()[1].status.value for _ in range(3)] == ["ok", "ok", "budget_exhausted"]
    assert len(stub_agent.calls) == 2


def test_budget_config_invalid_values_use_default(monkeypatch):
    assert GeminiTeacherConfig.from_env().max_calls_per_hour == 200
    for bad in ("0", "-3", "abc"):
        monkeypatch.setenv("GEMINI_TEACHER_MAX_CALLS_PER_HOUR", bad)
        assert GeminiTeacherConfig.from_env().max_calls_per_hour == 200


def test_run_agent_collects_tool_calls_from_events(monkeypatch):
    from google.adk.runners import Runner

    call = SimpleNamespace(id="c1", name="verify_brand_official_domain", args={"brand_name": "PayPal"})
    response = SimpleNamespace(id="c1", name="verify_brand_official_domain", response={"known": True})
    text_part = SimpleNamespace(text=finding_json(), thought=False)
    events = [
        SimpleNamespace(get_function_calls=lambda: [call], get_function_responses=lambda: [], is_final_response=lambda: False, content=None),
        SimpleNamespace(get_function_calls=lambda: [], get_function_responses=lambda: [response], is_final_response=lambda: False, content=None),
        SimpleNamespace(
            get_function_calls=lambda: [], get_function_responses=lambda: [], is_final_response=lambda: True,
            content=SimpleNamespace(parts=[text_part]),
        ),
    ]

    async def fake_run_async(self, **_kwargs):
        for event in events:
            yield event

    monkeypatch.setattr(Runner, "run_async", fake_run_async)
    monkeypatch.setattr(gemini_teacher, "build_agent", lambda config=None: object())
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")
    text, tool_calls = asyncio.run(gemini_teacher._run_agent(None, {"page_host": "paypa1.xyz"}))
    assert json.loads(text)["action"] == "BLOCK"
    assert [(c.name, c.args, c.result) for c in tool_calls] == [
        ("verify_brand_official_domain", {"brand_name": "PayPal"}, {"known": True})
    ]


def test_run_agent_excludes_set_model_response_from_tool_calls(monkeypatch):
    from google.adk.runners import Runner

    call = SimpleNamespace(id="c1", name="verify_brand_official_domain", args={"brand_name": "PayPal"})
    response = SimpleNamespace(id="c1", name="verify_brand_official_domain", response={"known": True})
    set_call = SimpleNamespace(id="c2", name="set_model_response", args={"action": "BLOCK"})
    set_response = SimpleNamespace(id="c2", name="set_model_response", response={"ok": True})
    text_part = SimpleNamespace(text=finding_json(), thought=False)

    def event(calls=(), responses=(), final=False, content=None):
        return SimpleNamespace(
            get_function_calls=lambda: list(calls), get_function_responses=lambda: list(responses),
            is_final_response=lambda: final, content=content,
        )

    events = [
        event(calls=[call]),
        event(responses=[response]),
        event(calls=[set_call]),
        event(responses=[set_response]),
        event(final=True, content=SimpleNamespace(parts=[text_part])),
    ]

    async def fake_run_async(self, **_kwargs):
        for item in events:
            yield item

    monkeypatch.setattr(Runner, "run_async", fake_run_async)
    monkeypatch.setattr(gemini_teacher, "build_agent", lambda config=None: object())
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-value")
    text, tool_calls = asyncio.run(gemini_teacher._run_agent(None, {"page_host": "paypa1.xyz"}))
    assert json.loads(text)["action"] == "BLOCK"
    assert [c.name for c in tool_calls] == ["verify_brand_official_domain"]


def test_threat_memory_timeout_returns_unavailable(monkeypatch):
    class SlowSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def execute(self, *_args, **_kwargs):
            await asyncio.sleep(5)

    monkeypatch.setattr(gemini_agent, "threat_memory_session_factory", SlowSession)
    monkeypatch.setattr(gemini_agent, "THREAT_MEMORY_TIMEOUT_S", 0.05)
    assert asyncio.run(lookup_threat_memory_bank("evil.test")) == {"available": False}


def test_escalate_configured_calls_agent_once_and_caches(configured, stub_agent, api, monkeypatch):
    contents = []
    real_build_content = gemini_agent.build_content

    def spy(payload, brief):
        content = real_build_content(payload, brief)
        contents.append(content)
        return content

    monkeypatch.setattr(gemini_agent, "build_content", spy)
    body = json.loads(make_payload(screenshot=SCREENSHOT).model_dump_json())
    first = api.post("/v1/escalate", json=body)
    assert first.status_code == 200
    assert first.json()["teacherModelVersion"] == "gemini-adk/gemini-3.5-flash-lite"
    assert len(stub_agent.calls) == 1 and len(contents[0].parts) == 2
    second = api.post("/v1/escalate", json=body).json()
    assert second["teacherModelVersion"] == "gemini-adk/gemini-3.5-flash-lite"
    assert len(stub_agent.calls) == 1


def test_escalate_configured_failure_falls_back_and_is_not_cached(configured, stub_agent, api):
    body = api_payload()
    stub_agent.behavior["result"] = RuntimeError("boom")
    response = api.post("/v1/escalate", json=body)
    assert response.status_code == 200
    assert response.json()["teacherModelVersion"] == "cloud-evidence-v2-fallback"
    stub_agent.behavior["result"] = finding_json()
    assert api.post("/v1/escalate", json=body).json()["teacherModelVersion"] == "gemini-adk/gemini-3.5-flash-lite"
    assert len(stub_agent.calls) == 2


def test_escalate_configured_neutral_known_host_uses_prior(configured, stub_agent, api):
    body = json.loads(make_payload("google.com").model_dump_json())
    response = api.post("/v1/escalate", json=body)
    assert response.status_code == 200
    assert response.json()["actionOverride"] == "ALLOW"
    assert stub_agent.calls == []


def test_escalate_unconfigured_is_deterministic(stub_agent, api):
    body = api.post("/v1/escalate", json=api_payload()).json()
    assert body["teacherModelVersion"] == "cloud-evidence-v2"
    assert stub_agent.calls == []


def jpeg_url(size=(2048, 1152)):
    buffer = io.BytesIO()
    Image.new("RGB", size, (30, 90, 200)).save(buffer, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


SCREEN = dict(
    screen_risk_score=0.9, detected_brand="PayPal", credential_form_visible=True,
    urgency_cues=["Account suspended"], on_screen_url_mismatch=True, reasons=["Fake address bar"],
)


def test_parse_finding_accepts_screen_analysis_schema():
    parsed = gemini_agent.parse_finding(finding_json(screen_analysis=SCREEN))
    assert parsed.risk_score == 0.95 and parsed.screen_analysis.detected_brand == "PayPal"
    assert gemini_agent.parse_finding(finding_json(screen_analysis=None)).screen_analysis is None
    with pytest.raises(Exception):
        gemini_agent.parse_finding(json.dumps(dict(json.loads(finding_json()), risk_score=1.5)))
    with pytest.raises(Exception):
        gemini_agent.parse_finding(json.dumps({k: v for k, v in json.loads(finding_json()).items() if k != "risk_score"}))


def test_brief_carries_screenshot_dimensions_and_content_is_jpeg():
    shot = make_payload(screenshot=jpeg_url())
    brief = build_evidence_brief(shot, cloud_evidence_snapshot(shot), None)
    assert brief["screenshot"] == {"width": 2048, "height": 1152}
    assert build_content(shot, brief).parts[1].inline_data.mime_type == "image/jpeg"
    assert build_evidence_brief(make_payload(), cloud_evidence_snapshot(make_payload()), None)["screenshot"] is None
    undecodable = make_payload(screenshot=SCREENSHOT)
    assert build_evidence_brief(undecodable, cloud_evidence_snapshot(undecodable), None)["screenshot"] is None


def test_agent_requests_high_media_resolution(configured):
    from google.genai import types

    assert gemini_teacher.build_agent().generate_content_config.media_resolution == types.MediaResolution.MEDIA_RESOLUTION_HIGH


def test_agent_requests_medium_thinking_for_tool_calls(configured):
    from google.genai import types

    config = gemini_teacher.build_agent().generate_content_config
    assert config.thinking_config.thinking_level == types.ThinkingLevel.MEDIUM


def test_rail_allow_clamps_risk_to_ceiling():
    result = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand=None, risk_score=0.9), baseline(), {"hostname": "paypa1.xyz"}
    )
    assert result["action"] == "ALLOW" and result["risk_score"] == 0.15


def test_rail_low_confidence_block_risk_stays_in_warn_band():
    result = apply_safety_rails(finding(confidence=0.6, risk_score=0.97), baseline(), {"hostname": "paypa1.xyz"})
    assert result["action"] == "WARN" and 0.15 <= result["risk_score"] <= 0.85


def test_rail_baseline_block_keeps_risk_at_least_baseline():
    result = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand=None, risk_score=0.2),
        baseline("BLOCK", 0.97, risk_score=0.97), {"hostname": "paypa1.xyz"},
    )
    assert result["action"] == "BLOCK" and result["risk_score"] >= max(0.85, 0.97)
    low = apply_safety_rails(
        finding(is_phishing=False, action="ALLOW", target_brand=None, risk_score=0.2),
        baseline("BLOCK", 0.9, risk_score=0.86), {"hostname": "paypa1.xyz"},
    )
    assert low["risk_score"] == 0.86


def test_rail_block_risk_floor():
    result = apply_safety_rails(finding(confidence=0.95, risk_score=0.7), baseline(), {"hostname": "paypa1.xyz"})
    assert result["action"] == "BLOCK" and result["risk_score"] == 0.85


def test_rail_brand_contradiction_uses_baseline_risk_and_caps_screen_score():
    result = apply_safety_rails(
        finding(risk_score=0.95, screen_analysis=SCREEN), baseline(risk_score=0.05), {"hostname": "www.paypal.com"}
    )
    assert result["action"] == "ALLOW" and result["risk_score"] == 0.05
    assert result["screen_analysis"]["screenRiskScore"] == 0.05
    assert result["screen_analysis"]["detectedBrand"] == "PayPal"


def test_rail_drops_screen_analysis_without_screenshot():
    result = apply_safety_rails(
        finding(screen_analysis=SCREEN), baseline(), {"hostname": "paypa1.xyz"}, has_screenshot=False
    )
    assert result["screen_analysis"] is None
    kept = apply_safety_rails(finding(screen_analysis=SCREEN), baseline(), {"hostname": "paypa1.xyz"})
    assert kept["screen_analysis"]["screenRiskScore"] == 0.9 and kept["screen_analysis"]["urgencyCues"] == ["Account suspended"]


def test_deterministic_and_fallback_verdicts_carry_baseline_risk(stub_agent):
    payload = make_payload()
    expected = asyncio.run(cloud_dispatcher._baseline(payload, None, None))[0]["risk_score"]
    deterministic = asyncio.run(cloud_dispatcher.evaluate(payload))
    assert deterministic.riskScore == expected and deterministic.screenAnalysis is None
    fallback, _trace = asyncio.run(cloud_dispatcher.evaluate_with_trace(payload))
    assert fallback.teacherModelVersion == "cloud-evidence-v2-fallback"
    assert fallback.riskScore == expected and fallback.screenAnalysis is None


def test_escalate_returns_risk_score_and_screen_analysis_and_caches_them(configured, stub_agent, api, monkeypatch):
    monkeypatch.setattr(cloud_dispatcher, "vision_analyzer", SimpleNamespace(match=lambda _shot: None))
    stub_agent.behavior["result"] = finding_json(screen_analysis=SCREEN)
    body = json.loads(make_payload(screenshot=jpeg_url()).model_dump_json())
    first = api.post("/v1/escalate", json=body)
    assert first.status_code == 200
    data = first.json()
    assert data["teacherModelVersion"] == "gemini-adk/gemini-3.5-flash-lite"
    assert data["riskScore"] == 0.95
    assert data["screenAnalysis"]["detectedBrand"] == "PayPal"
    assert data["screenAnalysis"]["credentialFormVisible"] is True
    second = api.post("/v1/escalate", json=body).json()
    assert len(stub_agent.calls) == 1
    assert second["riskScore"] == 0.95 and second["screenAnalysis"] == data["screenAnalysis"]

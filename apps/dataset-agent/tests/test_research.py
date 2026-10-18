"""Tests for the Deep Research stage (all Gemini calls stubbed)."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from google.adk.models import BaseLlm, LlmResponse
from google.genai import types

from phishguard_dataset_agent.config import DatasetAgentConfig
from phishguard_dataset_agent.research.gemini_client import GeminiResearchClient
from phishguard_dataset_agent.research.deep_research import (
    DeepResearchCollector,
    load_research_topics,
)
from phishguard_dataset_agent.research.models import (
    CuratedRecord,
    CuratedResearchBatch,
    DiscoveredSource,
    ResearchReport,
)


class _FakeInteractions:
    def __init__(self, statuses, text="REPORT TEXT"):
        self.statuses = list(statuses)
        self.text = text
        self.create_kwargs = None

    async def create(self, **kwargs):
        self.create_kwargs = kwargs
        return SimpleNamespace(id="ix-1", status="queued")

    async def get(self, interaction_id):
        status = self.statuses.pop(0) if self.statuses else "completed"
        text = self.text if status == "completed" else None
        return SimpleNamespace(id=interaction_id, status=status, output_text=text, steps=None, errors=None)


class _FakeAio:
    def __init__(self, interactions=None, models=None):
        self.interactions = interactions
        self.models = models


def _gemini_client_with(interactions=None, models=None) -> GeminiResearchClient:
    client = GeminiResearchClient(api_key="test-key")
    client._client = SimpleNamespace(aio=_FakeAio(interactions=interactions, models=models))
    return client


def test_run_deep_research_completed():
    interactions = _FakeInteractions(["in_progress", "completed"])
    client = _gemini_client_with(interactions=interactions)

    async def _run():
        return await client.run_deep_research("prompt", timeout_s=60, poll_s=0.001)

    report = asyncio.run(_run())
    assert report.status == "completed"
    assert report.interaction_id == "ix-1"
    assert report.text == "REPORT TEXT"
    assert interactions.create_kwargs["background"] is True
    assert interactions.create_kwargs["agent"] == "deep-research-preview-04-2026"
    assert interactions.create_kwargs["agent_config"]["type"] == "deep-research"
    assert interactions.create_kwargs["input"] == "prompt"


def test_run_deep_research_failed_and_timeout():
    failed_client = _gemini_client_with(interactions=_FakeInteractions(["failed"]))

    async def _failed():
        return await failed_client.run_deep_research("p", timeout_s=60, poll_s=0.001)

    assert asyncio.run(_failed()).status == "failed"

    timeout_client = _gemini_client_with(interactions=_FakeInteractions(["in_progress"] * 100))

    async def _timeout():
        return await timeout_client.run_deep_research("p", timeout_s=0, poll_s=0.001)

    assert asyncio.run(_timeout()).status == "timeout"


class _ScriptedLlm(BaseLlm):
    """Fake curator model: one tool-call turn, then the scripted final JSON."""

    model: str = "fake-curator"
    final_text: str = "{}"
    raise_error: bool = False
    requests: list = []

    async def generate_content_async(self, llm_request, stream=False):
        self.requests.append(llm_request)
        if self.raise_error:
            raise RuntimeError("curator down")
        responded = any(
            part.function_response for content in llm_request.contents for part in (content.parts or [])
        )
        if not responded:
            parts = [
                types.Part.from_function_call(name="normalize_candidates", args={"urls": ["hxxps://evil[.]example[.]com/login"]}),
                types.Part.from_function_call(name="lookup_brands", args={"brand_names": ["Microsoft"]}),
                types.Part.from_function_call(name="check_verified_feeds", args={"urls": ["https://evil.example.com/login"]}),
            ]
        else:
            parts = [types.Part.from_text(text=self.final_text)]
        yield LlmResponse(content=types.Content(role="model", parts=parts))


def _llm(batch=None, **kwargs):
    text = batch.model_dump_json() if batch is not None else "{}"
    return _ScriptedLlm(final_text=text, requests=[], **kwargs)


class _FakeResearchClient:
    def __init__(self, fail=False, status="completed", text="REPORT"):
        self.fail = fail
        self.status = status
        self.text = text
        self.prompts = []

    async def run_deep_research(self, prompt, timeout_s, poll_s=15.0):
        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("boom")
        return ResearchReport(interaction_id="ix-1", status=self.status, text=self.text)


def _collector(client, llm=None, **cfg_kwargs):
    cfg = DatasetAgentConfig(gemini_api_key="k", deep_research_enabled=True, **cfg_kwargs)
    return DeepResearchCollector(config=cfg, client=client, curator_model=llm or _llm())


def _record(url, label="phishing", citation="https://v.example/r", **kw):
    return CuratedRecord(url=url, claimed_label=label, citation_url=citation, topic_id="new_phishing_datasets", **kw)


def test_collector_runs_real_adk_pipeline_with_fake_llm_and_normalizes():
    batch = CuratedResearchBatch(
        records=[
            _record("hxxps://evil[.]example[.]com/login", target_brand="Microsoft", evidence="vendor IOC"),
            _record("hxxp://second-bad[.]net"),
            _record("hxxps://uncited[.]example", citation=None, evidence="no citation"),
            _record("ftp://not-http.example/x"),
            _record("hxxps://evil[.]example[.]com/login", evidence="dup"),
            _record("benign[.]site[.]org", label="benign"),
        ],
        discovered_sources=[
            DiscoveredSource(name="OpenPhish Community Feed", homepage="https://openphish.com/"),
            DiscoveredSource(name="BrandNewFeed", homepage="https://brandnew.example"),
        ],
    )
    llm = _llm(batch)
    client = _FakeResearchClient(text="REPORT BODY hxxps://evil[.]example[.]com/login")
    collector = _collector(client, llm)
    index = {"phishing_urls": {"https://evil.example.com/login": {"source_id": "openphish", "label": 1.0, "label_confidence": 0.97}},
             "phishing_hosts": {}, "benign_hosts": {}}

    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]], feed_index=index))

    urls = [f.url for f in result.findings]
    assert "https://evil.example.com/login" in urls and "http://second-bad.net/" in urls
    assert len(result.findings) == 3
    assert len([f for f in result.findings if f.label == 0.0]) == 1
    assert [s.name for s in result.discovered_sources] == ["BrandNewFeed"]
    assert result.interactions[0]["status"] == "completed"
    assert result.reports == [{"topic_id": collector.topics[0].id, "interaction_id": "ix-1",
                               "text": "REPORT BODY hxxps://evil[.]example[.]com/login"}]
    # two LLM turns: tool calls, then final JSON; the report text reached the curator
    assert len(llm.requests) == 2
    first_prompt = json.dumps([c.model_dump(mode="json") for c in llm.requests[0].contents], default=str)
    assert "REPORT BODY" in first_prompt
    tool_responses = [
        part.function_response for content in llm.requests[1].contents for part in (content.parts or [])
        if part.function_response
    ]
    by_name = {r.name: r.response for r in tool_responses}
    assert by_name["normalize_candidates"]["results"][0]["normalized"] == "https://evil.example.com/login"
    assert by_name["lookup_brands"]["results"][0]["canonical"]
    assert by_name["check_verified_feeds"]["results"][0] == {
        "input": "https://evil.example.com/login", "listed": True, "source_id": "openphish", "label": "phishing",
    }


def test_collector_caps_findings():
    batch = CuratedResearchBatch(records=[_record(f"hxxps://bad{i}[.]example[.]com/") for i in range(10)])
    collector = _collector(_FakeResearchClient(), _llm(batch), deep_research_max_urls=3)
    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]]))
    assert len(result.findings) == 3


def test_curator_failure_keeps_interactions_and_reports():
    collector = _collector(_FakeResearchClient(text="REPORT"), _llm(raise_error=True))
    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]]))
    assert result.findings == [] and result.discovered_sources == []
    assert result.interactions[0]["status"] == "completed"
    assert result.reports[0]["text"] == "REPORT"


def test_curator_malformed_output_yields_zero_findings():
    llm = _ScriptedLlm(final_text="not json", requests=[])
    collector = _collector(_FakeResearchClient(), llm)
    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]]))
    assert result.findings == [] and len(result.reports) == 1


@pytest.mark.parametrize("status", ["failed", "timeout"])
def test_gatherer_records_non_completed_statuses_and_skips_curator(status):
    llm = _llm()
    collector = _collector(_FakeResearchClient(status=status, text=""), llm)
    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]]))
    assert result.interactions[0]["status"] == status
    assert result.reports == [] and result.findings == []
    assert llm.requests == []


def test_gatherer_error_never_raises_and_records_error():
    collector = _collector(_FakeResearchClient(fail=True))
    result = asyncio.run(collector.collect("2026-10-13", topics_override=[collector.topics[0]]))
    assert result.findings == []
    assert result.interactions[0]["status"] == "error"


def test_collector_empty_without_key():
    no_key = DeepResearchCollector(config=DatasetAgentConfig(gemini_api_key=None))
    result = asyncio.run(no_key.collect("2026-10-13", topics_override=[no_key.topics[0]]))
    assert result.findings == []
    assert result.interactions == []


def test_prompt_contains_topic_and_registry_names():
    collector = _collector(_FakeResearchClient())
    brand_topic = next(t for t in collector.topics if "{brand}" in t.title)
    prompt = collector.build_prompt(brand_topic)
    assert "PhishGuard" in prompt
    assert "Brands of interest:" in prompt
    assert "{brand}" not in prompt
    for brand in brand_topic.brands:
        assert brand in prompt
    # registry names are embedded as already-known sources
    assert "OpenPhish" in prompt
    assert "Tranco" in prompt

    plain_topic = next(t for t in collector.topics if "{brand}" not in t.title)
    plain_prompt = collector.build_prompt(plain_topic)
    assert plain_topic.title in plain_prompt


def test_topics_seed_loads():
    topics = load_research_topics()
    assert len(topics) == 6
    assert {t.id for t in topics} == {
        "new_phishing_datasets",
        "brand_impersonation_campaigns",
        "aitm_phishing_kits",
        "government_advisories",
        "banking_credential_phishing",
        "typosquat_registrations",
    }


def test_pick_topics_deterministic():
    collector = _collector(_FakeResearchClient())
    first = collector.pick_topics("2026-10-13", 2)
    second = collector.pick_topics("2026-10-13", 2)
    assert [t.id for t in first] == [t.id for t in second]
    assert len(first) == 2

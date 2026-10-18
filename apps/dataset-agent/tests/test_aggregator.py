"""Tests for dataset aggregator workflow."""

import asyncio
import pytest
from phishguard_dataset_agent.config import DatasetAgentConfig
from phishguard_dataset_agent.aggregator.dataset_aggregator import (
    DatasetAggregator,
    AggregatedDatasetBatch,
)
from phishguard_dataset_agent.collector.models import FetchedPageMetadata
from phishguard_dataset_agent.collector.page_fetcher import PageFetcher
from phishguard_dataset_agent.sources.feeds import BaseFeedConnector, host_of
from phishguard_dataset_agent.sources.models import FeedRecord
from phishguard_dataset_agent.research.models import (
    DiscoveredSource,
    ProcessedUrlFinding,
    ResearchCycleResult,
)
from phishguard_dataset_agent.search.models import SearchResultItem
from phishguard_dataset_agent.search.providers import BaseSearchProvider, MockSearchProvider


def test_aggregator_run_cycle(mock_agent_config: DatasetAgentConfig):
    async def _run():
        aggregator = DatasetAggregator(config=mock_agent_config)
        batch = await aggregator.run_aggregation_cycle(sample_target=6, date_str="2026-10-07")

        assert isinstance(batch, AggregatedDatasetBatch)
        assert batch.date == "2026-10-07"
        assert batch.total_samples == 6
        assert len(batch.samples) == 6
        assert batch.phishing_count > 0
        assert batch.benign_count > 0
        assert batch.queries_executed > 0
        assert batch.urls_inspected > 0
    asyncio.run(_run())


class _FakeConnector(BaseFeedConnector):
    source_id = "fake_feed"

    def __init__(self, records):
        super().__init__()
        self._records = records

    async def _fetch(self, limit):
        return self._records


class _FakeResearchCollector:
    async def collect(self, date_str, topics_override=None, feed_index=None):
        return ResearchCycleResult(
            findings=[
                ProcessedUrlFinding(
                    url="https://research-bad.example/",
                    label=1.0,
                    target_brand="PayPal",
                    evidence="vendor IOC listing",
                    citation_url="https://vendor.example/report",
                    topic_id="new_phishing_datasets",
                )
            ],
            discovered_sources=[DiscoveredSource(name="BrandNewFeed", homepage="https://brandnew.example")],
            interactions=[{"id": "ix-1", "status": "completed", "topic_id": "new_phishing_datasets"}],
        )


def test_aggregator_feed_and_research_provenance(tmp_path):
    config = DatasetAgentConfig(
        output_dir=tmp_path / "out",
        lifecycle_dataset_dir=tmp_path / "lc",
        search_provider="auto",
        daily_sample_target=10,
        phishing_target_ratio=0.5,
        deep_research_enabled=True,
        gemini_api_key="test-key",
    )
    records = [
        FeedRecord(url="https://evil.example.com/login", label=1.0, source_id="openphish",
                   label_confidence=0.97, label_reason="feed IOC", target_brand="Microsoft"),
        FeedRecord(url="https://example.com/", label=0.0, source_id="tranco",
                   label_confidence=0.95, label_reason="benign anchor"),
        FeedRecord(url="https://clean.example.org/", label=0.0, source_id="tranco",
                   label_confidence=0.95, label_reason="benign anchor"),
    ]
    aggregator = DatasetAggregator(
        config=config,
        search_provider=MockSearchProvider(),
        feed_connectors=[_FakeConnector(records)],
        research_collector=_FakeResearchCollector(),
    )
    aggregator.fetcher = PageFetcher(mock_mode=True)

    async def _run():
        return await aggregator.run_aggregation_cycle(sample_target=10, date_str="2026-10-13")

    batch = asyncio.run(_run())

    feed_samples = [s for s in batch.samples if s.provenance and s.provenance.sourceType == "public_feed"]
    assert feed_samples, "expected public_feed samples"
    for s in feed_samples:
        assert s.provenance.labelSource == "verified_feed"
        assert s.provenance.labelConfidence >= 0.95

    urls = {s.url for s in batch.samples}
    assert "https://evil.example.com/login" in urls
    # benign anchor overlapping a phishing host is dropped by the shared-hosting guard
    assert "https://example.com/" not in urls
    assert "https://clean.example.org/" in urls

    research_samples = [s for s in batch.samples if s.provenance and s.provenance.sourceType == "research_agent"]
    assert len(research_samples) == 1
    assert research_samples[0].provenance.labelSource == "llm_research"
    assert research_samples[0].provenance.labelConfidence == 0.6
    assert research_samples[0].url == "https://research-bad.example/"
    assert "fake_feed" in batch.feeds_used
    assert batch.research is not None
    assert batch.research["interactions"][0]["status"] == "completed"
    assert len(batch.research["discovered_sources"]) == 1


def test_aggregator_mock_mode_skips_feeds_and_research(mock_agent_config: DatasetAgentConfig):
    """In mock mode, injected live connectors and research must not run."""
    aggregator = DatasetAggregator(
        config=mock_agent_config,
        feed_connectors=[_FakeConnector([
            FeedRecord(url="https://should-not-appear.example/", label=1.0,
                       source_id="x", label_confidence=0.97, label_reason="x")
        ])],
        research_collector=_FakeResearchCollector(),
    )

    async def _run():
        return await aggregator.run_aggregation_cycle(sample_target=6, date_str="2026-10-07")

    batch = asyncio.run(_run())
    assert "should-not-appear.example" not in {s.url for s in batch.samples}
    assert batch.research is None
    assert "fake_feed" not in batch.feeds_used


class _FakeTrancoConnector(BaseFeedConnector):
    source_id = "tranco"

    def __init__(self, n: int = 1000):
        super().__init__()
        self.last_limit = None
        self._records = [
            FeedRecord(
                url=f"https://domain-{i:04d}.example/",
                label=0.0,
                source_id="tranco",
                label_confidence=0.95,
                label_reason=f"Tranco rank {i}",
            )
            for i in range(n)
        ]

    async def _fetch(self, limit):
        self.last_limit = limit
        return self._records[:limit]


def _feed_sample_urls(batch):
    return [
        s.url
        for s in batch.samples
        if s.provenance and s.provenance.sourceType == "public_feed"
    ]


def test_feed_shuffle_seeded_by_cycle_date(tmp_path):
    """Same date reproduces the same feed picks; a new date reshuffles."""

    def make_aggregator():
        config = DatasetAgentConfig(
            output_dir=tmp_path / "out",
            lifecycle_dataset_dir=tmp_path / "lc",
            search_provider="auto",
            daily_sample_target=10,
            phishing_target_ratio=0.5,
            fetch_feed_pages=False,
        )
        connector = _FakeTrancoConnector(1000)
        aggregator = DatasetAggregator(
            config=config,
            search_provider=MockSearchProvider(),
            feed_connectors=[connector],
        )
        aggregator.fetcher = PageFetcher(mock_mode=True)
        return aggregator, connector

    agg_a, conn_a = make_aggregator()
    day1 = _feed_sample_urls(asyncio.run(agg_a.run_aggregation_cycle(sample_target=10, date_str="2026-10-13")))

    agg_b, _ = make_aggregator()
    day2 = _feed_sample_urls(asyncio.run(agg_b.run_aggregation_cycle(sample_target=10, date_str="2026-10-14")))

    agg_c, _ = make_aggregator()
    day1_repeat = _feed_sample_urls(asyncio.run(agg_c.run_aggregation_cycle(sample_target=10, date_str="2026-10-13")))

    assert conn_a.last_limit == agg_a.config.tranco_top_n
    assert day1 and day2
    assert day1 != day2
    assert day1 == day1_repeat


class _FakeManyItemsProvider(BaseSearchProvider):
    def __init__(self, items):
        self._items = items

    async def search(self, query):
        return self._items


class _PeakTrackingFetcher:
    def __init__(self, delay: float = 0.01):
        self._delay = delay
        self.in_flight = 0
        self.peak = 0

    async def fetch(self, url):
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        await asyncio.sleep(self._delay)
        self.in_flight -= 1
        return FetchedPageMetadata(url=url, final_url=url, domain=host_of(url) or "example.com")


def test_fetch_concurrency_bounds_peak_in_flight(tmp_path):
    """Chunked gathers must overlap fetches but stay under fetch_concurrency."""
    config = DatasetAgentConfig(
        output_dir=tmp_path / "out",
        lifecycle_dataset_dir=tmp_path / "lc",
        search_provider="mock",
        daily_sample_target=20,
        fetch_concurrency=4,
    )
    items = [
        SearchResultItem(
            url=f"https://probe-{i:02d}.example/", engine="fake", intent="benign_anchor"
        )
        for i in range(16)
    ]
    aggregator = DatasetAggregator(config=config, search_provider=_FakeManyItemsProvider(items))
    tracker = _PeakTrackingFetcher()
    aggregator.fetcher = tracker

    asyncio.run(aggregator.run_aggregation_cycle(sample_target=20, date_str="2026-10-13"))

    assert tracker.peak > 1
    assert tracker.peak <= config.fetch_concurrency


def _research_aggregator(tmp_path):
    config = DatasetAgentConfig(output_dir=tmp_path / "out", lifecycle_dataset_dir=tmp_path / "lc", search_provider="mock")
    return DatasetAggregator(config=config)


def _finding(url, label, evidence="vendor IOC"):
    return ProcessedUrlFinding(url=url, label=label, evidence=evidence, citation_url="https://v.example/r",
                               topic_id="new_phishing_datasets")


def _index():
    from phishguard_dataset_agent.research.corroboration import build_feed_index

    return build_feed_index([
        FeedRecord(url="https://evil.example.com/login/?a=1", label=1.0, source_id="openphish",
                   label_confidence=0.97, label_reason="IOC"),
        FeedRecord(url="https://listed-benign.example.org/", label=0.0, source_id="tranco",
                   label_confidence=0.95, label_reason="top site"),
        FeedRecord(url="https://phishdb.example.net/x", label=1.0, source_id="phishing_database",
                   label_confidence=0.90, label_reason="db"),
    ])


def test_research_finding_corroborated_by_exact_url_is_training_eligible(tmp_path):
    from phishguard_dataset_agent.storage.sink import DatasetSink

    aggregator = _research_aggregator(tmp_path)
    sample = aggregator._build_research_sample(_finding("HTTPS://Evil.Example.com/login?a=1", 1.0), _index())
    assert sample.provenance.sourceType == "research_agent"
    assert sample.provenance.labelSource == "verified_feed"
    assert sample.provenance.labelConfidence == 0.97
    assert sample.provenance.labelReason == "Deep Research finding corroborated by openphish"
    sink = DatasetSink(output_dir=tmp_path / "out", lifecycle_dataset_dir=tmp_path / "lc", export_to_ml_lifecycle=False)
    assert sink.persist_daily_batch([sample], date_str="2026-10-13")["training_eligible_samples"] == 1


def test_research_benign_finding_corroborated_by_host(tmp_path):
    aggregator = _research_aggregator(tmp_path)
    sample = aggregator._build_research_sample(_finding("https://listed-benign.example.org/about", 0.0), _index())
    assert sample.provenance.labelSource == "verified_feed" and sample.provenance.labelConfidence == 0.95
    assert sample.label == 0.0


def test_unmatched_research_finding_stays_llm_and_is_withheld(tmp_path):
    from phishguard_dataset_agent.storage.sink import DatasetSink

    aggregator = _research_aggregator(tmp_path)
    sample = aggregator._build_research_sample(_finding("https://unlisted.example.com/", 1.0), _index())
    assert sample.provenance.labelSource == "llm_research" and sample.provenance.labelConfidence == 0.6
    sink = DatasetSink(output_dir=tmp_path / "out", lifecycle_dataset_dir=tmp_path / "lc", export_to_ml_lifecycle=False)
    assert sink.persist_daily_batch([sample], date_str="2026-10-13")["training_eligible_samples"] == 0


def test_label_conflict_is_withheld_and_noted(tmp_path):
    aggregator = _research_aggregator(tmp_path)
    benign_claim = aggregator._build_research_sample(_finding("https://evil.example.com/login?a=1", 0.0), _index())
    assert benign_claim.provenance.labelSource == "llm_research" and benign_claim.label == 0.0
    assert "conflicts with openphish" in benign_claim.provenance.labelReason
    phish_claim = aggregator._build_research_sample(_finding("https://listed-benign.example.org/login", 1.0), _index())
    assert phish_claim.provenance.labelSource == "llm_research" and phish_claim.label == 1.0
    assert "conflicts with tranco" in phish_claim.provenance.labelReason


def test_host_only_match_for_phishing_finding_is_not_corroborated(tmp_path):
    aggregator = _research_aggregator(tmp_path)
    sample = aggregator._build_research_sample(_finding("https://evil.example.com/other-path", 1.0), _index())
    assert sample.provenance.labelSource == "llm_research"


def test_corroborated_below_threshold_feed_is_still_withheld(tmp_path):
    from phishguard_dataset_agent.storage.sink import DatasetSink

    aggregator = _research_aggregator(tmp_path)
    sample = aggregator._build_research_sample(_finding("https://phishdb.example.net/x", 1.0), _index())
    assert sample.provenance.labelSource == "verified_feed" and sample.provenance.labelConfidence == 0.90
    sink = DatasetSink(output_dir=tmp_path / "out", lifecycle_dataset_dir=tmp_path / "lc", export_to_ml_lifecycle=False)
    assert sink.persist_daily_batch([sample], date_str="2026-10-13")["training_eligible_samples"] == 0


def test_cycle_passes_feed_index_and_reports_to_research(tmp_path):
    captured = {}

    class _Collector:
        async def collect(self, date_str, topics_override=None, feed_index=None):
            captured["index"] = feed_index
            return ResearchCycleResult(
                findings=[_finding("https://evil.example.com/login", 1.0)],
                reports=[{"topic_id": "t", "interaction_id": "ix", "text": "R"}],
            )

    config = DatasetAgentConfig(
        output_dir=tmp_path / "out", lifecycle_dataset_dir=tmp_path / "lc", search_provider="auto",
        daily_sample_target=2, phishing_target_ratio=0.5, deep_research_enabled=True, gemini_api_key="k",
    )
    records = [FeedRecord(url="https://evil.example.com/login", label=1.0, source_id="openphish",
                          label_confidence=0.97, label_reason="IOC")]
    aggregator = DatasetAggregator(
        config=config, search_provider=MockSearchProvider(),
        feed_connectors=[_FakeConnector(records)], research_collector=_Collector(),
    )
    aggregator.fetcher = PageFetcher(mock_mode=True)
    batch = asyncio.run(aggregator.run_aggregation_cycle(sample_target=2, date_str="2026-10-13"))
    assert "https://evil.example.com/login" in captured["index"]["phishing_urls"]
    assert batch.research["reports"][0]["text"] == "R"


def test_shared_host_conflict_vetoes_corroboration_both_ways(tmp_path):
    from phishguard_dataset_agent.research.corroboration import build_feed_index

    index = build_feed_index([
        FeedRecord(url="https://shared.example/", label=0.0, source_id="tranco",
                   label_confidence=0.95, label_reason="top site"),
        FeedRecord(url="https://shared.example/phish", label=1.0, source_id="openphish",
                   label_confidence=0.97, label_reason="IOC"),
    ])
    aggregator = _research_aggregator(tmp_path)
    benign = aggregator._build_research_sample(_finding("https://shared.example/", 0.0), index)
    assert benign.provenance.labelSource == "llm_research" and benign.provenance.labelConfidence == 0.6
    assert "conflicts with" in benign.provenance.labelReason
    phish = aggregator._build_research_sample(_finding("https://shared.example/phish", 1.0), index)
    assert phish.provenance.labelSource == "llm_research" and phish.provenance.labelConfidence == 0.6

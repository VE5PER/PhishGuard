"""Tests for search query generation and providers."""

import pytest
from phishguard_dataset_agent.search.models import SearchQuery, SearchResultItem
from phishguard_dataset_agent.search.query_generator import DatasetQueryGenerator
from phishguard_dataset_agent.search.providers import (
    MockSearchProvider,
    CompositeSearchProvider,
)


def test_query_generator_phishing_and_benign():
    generator = DatasetQueryGenerator(target_brands=["Microsoft", "Google"], seed=42)
    phish_queries = generator.generate_phishing_discovery_queries(count_per_brand=2)
    assert len(phish_queries) == 4
    for q in phish_queries:
        assert q.intent == "phishing_discovery"
        assert q.target_brand in ("Microsoft", "Google")
        assert len(q.query_text) > 0

    benign_queries = generator.generate_benign_anchor_queries(count_per_brand=1)
    assert len(benign_queries) == 2
    for q in benign_queries:
        assert q.intent == "benign_anchor"
        assert q.target_brand in ("Microsoft", "Google")


def test_query_generator_daily_batch():
    generator = DatasetQueryGenerator(target_brands=["Microsoft", "PayPal"], seed=42)
    batch = generator.generate_daily_query_batch(phishing_ratio=0.5, total_queries=6)
    assert len(batch) == 6
    phish_count = sum(1 for q in batch if q.intent == "phishing_discovery")
    benign_count = sum(1 for q in batch if q.intent == "benign_anchor")
    assert phish_count > 0
    assert benign_count > 0


def test_mock_search_provider():
    import asyncio
    async def _run():
        provider = MockSearchProvider()
        q_phish = SearchQuery(
            query_text="Microsoft account sign in verify",
            target_brand="Microsoft",
            intent="phishing_discovery",
            max_results=5,
        )
        items = await provider.search(q_phish)
        assert len(items) == 5
        for it in items:
            assert isinstance(it, SearchResultItem)
            assert it.url.startswith("http")
            assert it.target_brand == "Microsoft"

        q_benign = SearchQuery(
            query_text="Microsoft official portal",
            target_brand="Microsoft",
            intent="benign_anchor",
            max_results=2,
        )
        items_benign = await provider.search(q_benign)
        assert len(items_benign) == 2
        for it in items_benign:
            assert "microsoft.com" in it.url
    asyncio.run(_run())


def test_composite_search_provider_fallback():
    import asyncio
    async def _run():
        provider = CompositeSearchProvider(provider_name="mock")
        q = SearchQuery(
            query_text="PayPal verify account login",
            target_brand="PayPal",
            intent="phishing_discovery",
            max_results=3,
        )
        items = await provider.search(q)
        assert len(items) == 3
    asyncio.run(_run())

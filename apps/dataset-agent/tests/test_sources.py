"""Tests for the committed source registry and seed snapshot."""

import pytest
from phishguard_dataset_agent.sources.registry import load_registry, CONNECTORS
from phishguard_dataset_agent.sources.feeds import SeedSnapshotFeed, normalize_candidate_url


def test_registry_validates_and_ids_unique():
    registry = load_registry()
    assert len(registry) >= 8
    ids = [s.id for s in registry]
    assert len(ids) == len(set(ids))
    for spec in registry:
        if spec.connector:
            assert spec.connector in CONNECTORS, f"{spec.id} connector '{spec.connector}' unimplemented"


def test_registry_entries_have_required_metadata():
    registry = load_registry()
    by_id = {s.id: s for s in registry}
    assert by_id["openphish"].connector == "openphish"
    assert by_id["tranco"].connector == "tranco"
    assert by_id["phishing_database"].trust == "community"
    assert by_id["phiusiil"].kind == "dataset"


def test_seed_snapshot_loads_and_refangs():
    import asyncio

    async def _run():
        feed = SeedSnapshotFeed()
        return await feed.fetch(limit=500)

    records = asyncio.run(_run())
    assert len(records) >= 100
    phishing = [r for r in records if r.label == 1.0]
    benign = [r for r in records if r.label == 0.0]
    assert len(phishing) >= 50
    assert len(benign) >= 50
    for r in records:
        assert r.url.startswith(("http://", "https://"))
        assert "[.]" not in r.url
        assert "hxxp" not in r.url
        assert r.label_confidence >= 0.9


def test_normalize_candidate_url():
    assert normalize_candidate_url("hxxps://evil[.]example[.]com/login") == "https://evil.example.com/login"
    assert normalize_candidate_url("hxxp://a[.]b[.]phish(.)net/x") == "http://a.b.phish.net/x"
    assert normalize_candidate_url("example.org") == "https://example.org/"
    assert normalize_candidate_url("ftp://files.example.com") is None
    assert normalize_candidate_url("not a url at all") is None
    assert normalize_candidate_url("localhost") is None

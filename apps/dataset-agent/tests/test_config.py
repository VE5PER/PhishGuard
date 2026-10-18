"""Tests for DatasetAgentConfig."""

import os
from pathlib import Path
from phishguard_dataset_agent.config import DatasetAgentConfig, DEFAULT_TARGET_BRANDS


def test_default_config():
    config = DatasetAgentConfig()
    assert config.output_dir == Path("data/daily_datasets")
    assert config.interval_seconds == 86400
    assert config.daily_sample_target == 100
    assert config.search_provider == "auto"
    assert config.export_to_ml_lifecycle is True
    assert len(config.target_brands) == len(DEFAULT_TARGET_BRANDS)


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("DATASET_AGENT_OUTPUT_DIR", "/custom/data")
    monkeypatch.setenv("DATASET_AGENT_INTERVAL_SECONDS", "3600")
    monkeypatch.setenv("DATASET_AGENT_SAMPLE_TARGET", "50")
    monkeypatch.setenv("DATASET_AGENT_SEARCH_PROVIDER", "mock")
    monkeypatch.setenv("DATASET_AGENT_TARGET_BRANDS", "Apple,Netflix")
    monkeypatch.setenv("DATASET_AGENT_EXPORT_LIFECYCLE", "false")

    config = DatasetAgentConfig.from_env()
    assert config.output_dir == Path("/custom/data")
    assert config.interval_seconds == 3600
    assert config.daily_sample_target == 50
    assert config.search_provider == "mock"
    assert config.target_brands == ["Apple", "Netflix"]
    assert config.export_to_ml_lifecycle is False


def test_feed_and_research_config_from_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("DATASET_AGENT_FEED_SOURCES", "openphish,phishing_database")
    monkeypatch.setenv("DATASET_AGENT_TRANCO_TOP_N", "5000")
    monkeypatch.setenv("DATASET_AGENT_FETCH_FEED_PAGES", "true")
    monkeypatch.setenv("DATASET_AGENT_FETCH_CONCURRENCY", "4")
    monkeypatch.setenv("GEMINI_API_KEY", "gk-test")
    monkeypatch.setenv("DATASET_AGENT_DEEP_RESEARCH_ENABLED", "true")
    monkeypatch.setenv("DATASET_AGENT_DEEP_RESEARCH_TASKS", "2")
    monkeypatch.setenv("DATASET_AGENT_DEEP_RESEARCH_TIMEOUT_SECONDS", "900")
    monkeypatch.setenv("DATASET_AGENT_DEEP_RESEARCH_MAX_URLS", "25")
    monkeypatch.setenv("DATASET_AGENT_EXTRACTION_MODEL", "gemini-x")

    config = DatasetAgentConfig.from_env()
    assert config.feed_sources == ["openphish", "phishing_database"]
    assert config.tranco_top_n == 5000
    assert config.fetch_feed_pages is True
    assert config.fetch_concurrency == 4
    assert config.gemini_api_key == "gk-test"
    assert config.deep_research_enabled is True
    assert config.deep_research_tasks_per_cycle == 2
    assert config.deep_research_timeout_seconds == 900
    assert config.deep_research_max_urls == 25
    assert config.extraction_model == "gemini-x"


def test_lifecycle_default_changed_away_from_sota(monkeypatch):
    monkeypatch.delenv("DATASET_AGENT_LIFECYCLE_DIR", raising=False)
    config = DatasetAgentConfig.from_env()
    assert config.lifecycle_dataset_dir == Path("data/phishguard_daily_aggregated")
    assert DatasetAgentConfig().lifecycle_dataset_dir == Path("data/phishguard_daily_aggregated")

"""Configuration module for PhishGuard Dataset Agent."""

import os
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


DEFAULT_TARGET_BRANDS: List[str] = [
    "Microsoft",
    "Google",
    "Apple",
    "PayPal",
    "Bank of America",
    "Amazon",
    "Facebook",
    "Netflix",
    "Chase",
    "Wells Fargo",
    "Adobe",
    "Yahoo",
    "eBay",
    "Steam",
    "LinkedIn",
    "DHL",
    "Dropbox",
    "DocuSign",
    "Coinbase",
    "WhatsApp",
]


class DatasetAgentConfig(BaseModel):
    """Runtime configuration for the daily dataset gathering agent."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid")

    output_dir: Path = Field(
        default=Path("data/daily_datasets"),
        description="Root path where daily gathered datasets are archived",
    )
    schedule_cron: str = Field(
        default="0 2 * * *",
        description="Cron expression for daily execution schedule (e.g. daily at 02:00 UTC)",
    )
    interval_seconds: int = Field(
        default=86400,
        ge=60,
        description="Daily loop sleep interval in seconds (default: 86400 / 24h)",
    )
    target_brands: List[str] = Field(
        default_factory=lambda: list(DEFAULT_TARGET_BRANDS),
        description="Target brand identities to monitor and discover via search",
    )
    daily_sample_target: int = Field(
        default=100,
        ge=2,
        description="Target number of validated multimodal samples to aggregate each day",
    )
    search_provider: str = Field(
        default="auto",
        description="Web search engine provider: 'auto', 'duckduckgo', 'serpapi', or 'mock'",
    )
    search_api_key: Optional[str] = Field(
        default=None,
        description="Optional API key for external search providers (e.g. SERPAPI_KEY)",
    )
    phishing_target_ratio: float = Field(
        default=0.50,
        ge=0.0,
        le=1.0,
        description="Target balance ratio of phishing vs benign samples in aggregated dataset",
    )
    max_search_results_per_query: int = Field(
        default=10,
        ge=1,
        le=100,
        description="Maximum search result URLs to harvest per query",
    )
    request_timeout_seconds: float = Field(
        default=8.0,
        ge=1.0,
        description="Network timeout when probing and fetching candidate web pages",
    )
    export_to_ml_lifecycle: bool = Field(
        default=True,
        description="Whether to export to ML lifecycle training-ready format (tensors.npz/manifest)",
    )
    lifecycle_dataset_dir: Optional[Path] = Field(
        default=Path("data/phishguard_daily_aggregated"),
        description="Directory for ml-lifecycle multimodal training dataset synchronization",
    )
    feed_sources: List[str] = Field(
        default_factory=lambda: ["openphish", "tranco"],
        description="Public feed connector ids enabled for each aggregation cycle",
    )
    tranco_top_n: int = Field(
        default=10000,
        ge=100,
        description="Number of top-ranked Tranco domains to treat as benign anchors",
    )
    fetch_feed_pages: bool = Field(
        default=False,
        description="Whether to fetch live page content for feed-listed URLs",
    )
    fetch_concurrency: int = Field(
        default=8,
        ge=1,
        description="Maximum concurrent page fetches during aggregation",
    )
    gemini_api_key: Optional[str] = Field(
        default=None,
        description="Gemini API key for Deep Research (GEMINI_API_KEY)",
    )
    deep_research_enabled: bool = Field(
        default=False,
        description="Whether to run the Gemini Deep Research discovery stage each cycle",
    )
    deep_research_agent: str = Field(
        default="deep-research-preview-04-2026",
        description="Gemini Deep Research agent identifier",
    )
    deep_research_tasks_per_cycle: int = Field(
        default=1,
        ge=0,
        description="Number of research topics to investigate per aggregation cycle",
    )
    deep_research_timeout_seconds: int = Field(
        default=1800,
        ge=60,
        description="Maximum seconds to poll a single Deep Research interaction",
    )
    deep_research_max_urls: int = Field(
        default=50,
        ge=0,
        description="Maximum research-derived URL findings kept per cycle",
    )
    extraction_model: str = Field(
        default="gemini-3.6-flash",
        description="Gemini model driving the ADK dataset curator over Deep Research reports",
    )
    random_seed: int = Field(
        default=42,
        description="Random seed for repeatable synthetic dynamics and feature extraction",
    )

    @classmethod
    def from_env(cls) -> "DatasetAgentConfig":
        """Load configuration from environment variables with sensible defaults."""
        out_dir_str = os.environ.get("DATASET_AGENT_OUTPUT_DIR")
        out_dir = Path(out_dir_str) if out_dir_str else Path("data/daily_datasets")

        interval = int(os.environ.get("DATASET_AGENT_INTERVAL_SECONDS", "86400"))
        cron_expr = os.environ.get("DATASET_AGENT_SCHEDULE_CRON", "0 2 * * *")
        sample_target = int(os.environ.get("DATASET_AGENT_SAMPLE_TARGET", "100"))
        provider = os.environ.get("DATASET_AGENT_SEARCH_PROVIDER", "auto")
        api_key = os.environ.get("DATASET_AGENT_SEARCH_API_KEY") or os.environ.get("SERPAPI_API_KEY")

        brands_env = os.environ.get("DATASET_AGENT_TARGET_BRANDS")
        if brands_env:
            brands = [b.strip() for b in brands_env.split(",") if b.strip()]
        else:
            brands = list(DEFAULT_TARGET_BRANDS)

        export_lifecycle = os.environ.get("DATASET_AGENT_EXPORT_LIFECYCLE", "true").lower() in ("true", "1", "yes")
        lifecycle_dir_str = os.environ.get("DATASET_AGENT_LIFECYCLE_DIR")
        lifecycle_dir = Path(lifecycle_dir_str) if lifecycle_dir_str else Path("data/phishguard_daily_aggregated")

        feed_sources_env = os.environ.get("DATASET_AGENT_FEED_SOURCES", "openphish,tranco")
        feed_sources = [s.strip() for s in feed_sources_env.split(",") if s.strip()]

        return cls(
            output_dir=out_dir,
            schedule_cron=cron_expr,
            interval_seconds=interval,
            target_brands=brands,
            daily_sample_target=sample_target,
            search_provider=provider,
            search_api_key=api_key,
            export_to_ml_lifecycle=export_lifecycle,
            lifecycle_dataset_dir=lifecycle_dir,
            feed_sources=feed_sources,
            tranco_top_n=int(os.environ.get("DATASET_AGENT_TRANCO_TOP_N", "10000")),
            fetch_feed_pages=os.environ.get("DATASET_AGENT_FETCH_FEED_PAGES", "false").lower() in ("true", "1", "yes"),
            fetch_concurrency=int(os.environ.get("DATASET_AGENT_FETCH_CONCURRENCY", "8")),
            gemini_api_key=os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"),
            deep_research_enabled=os.environ.get("DATASET_AGENT_DEEP_RESEARCH_ENABLED", "false").lower() in ("true", "1", "yes"),
            deep_research_agent=os.environ.get("DATASET_AGENT_DEEP_RESEARCH_AGENT", "deep-research-preview-04-2026"),
            deep_research_tasks_per_cycle=int(os.environ.get("DATASET_AGENT_DEEP_RESEARCH_TASKS", "1")),
            deep_research_timeout_seconds=int(os.environ.get("DATASET_AGENT_DEEP_RESEARCH_TIMEOUT_SECONDS", "1800")),
            deep_research_max_urls=int(os.environ.get("DATASET_AGENT_DEEP_RESEARCH_MAX_URLS", "50")),
            extraction_model=os.environ.get("DATASET_AGENT_EXTRACTION_MODEL", "gemini-3.6-flash"),
        )

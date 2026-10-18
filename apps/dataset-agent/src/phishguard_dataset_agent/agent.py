"""DatasetAgent facade uniting search, collection, aggregation, storage, and scheduling."""

import logging
from typing import Any, Dict, List, Optional

from .config import DatasetAgentConfig
from .aggregator.dataset_aggregator import DatasetAggregator
from .storage.sink import DatasetSink
from .scheduler.daily_runner import DailyDatasetAgentScheduler
from .search.models import SearchQuery, SearchResultItem

logger = logging.getLogger(__name__)


class DatasetAgent:
    """Autonomous agent that searches the web daily and aggregates multimodal training datasets."""

    def __init__(self, config: Optional[DatasetAgentConfig] = None):
        self.config = config or DatasetAgentConfig.from_env()
        self.aggregator = DatasetAggregator(self.config)
        self.sink = DatasetSink(
            output_dir=self.config.output_dir,
            lifecycle_dataset_dir=self.config.lifecycle_dataset_dir,
            export_to_ml_lifecycle=self.config.export_to_ml_lifecycle,
        )
        self.scheduler = DailyDatasetAgentScheduler(
            config=self.config,
            aggregator=self.aggregator,
            sink=self.sink,
        )

    async def run_once(
        self,
        sample_target: Optional[int] = None,
        date_str: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a single dataset aggregation and archive cycle immediately."""
        logger.info("DatasetAgent executing run-once...")
        target = sample_target or self.config.daily_sample_target
        batch = await self.aggregator.run_aggregation_cycle(sample_target=target, date_str=date_str)
        research = batch.research or {}
        summary = self.sink.persist_daily_batch(
            samples=batch.samples,
            date_str=batch.date,
            extra_meta={
                "queries_executed": batch.queries_executed,
                "urls_inspected": batch.urls_inspected,
                "engines_used": batch.engines_used,
                "feeds_used": batch.feeds_used,
                "duration_seconds": batch.duration_seconds,
                "research_url_findings": len(research.get("url_findings", [])),
                "discovered_sources_count": len(research.get("discovered_sources", [])),
            },
            research_artifacts=batch.research,
        )
        return summary

    async def start_daily_daemon(self, run_immediately: bool = True) -> None:
        """Deploy the agent in continuous daily daemon mode."""
        logger.info("DatasetAgent starting daily deployment daemon...")
        await self.scheduler.start(run_immediately=run_immediately)

    def stop_daily_daemon(self) -> None:
        """Stop the running daemon."""
        self.scheduler.stop()

    def get_status(self) -> Dict[str, Any]:
        """Return agent health, status, and dataset storage metrics."""
        status = self.scheduler.get_status()
        status["config"] = {
            "output_dir": str(self.config.output_dir),
            "interval_seconds": self.config.interval_seconds,
            "daily_sample_target": self.config.daily_sample_target,
            "search_provider": self.config.search_provider,
            "target_brands_count": len(self.config.target_brands),
            "export_to_ml_lifecycle": self.config.export_to_ml_lifecycle,
            "lifecycle_dataset_dir": str(self.config.lifecycle_dataset_dir) if self.config.lifecycle_dataset_dir else None,
            "feed_sources": self.config.feed_sources,
            "deep_research_enabled": self.config.deep_research_enabled,
            "gemini_configured": bool(self.config.gemini_api_key),
        }
        return status

    async def test_search(
        self,
        query_text: str,
        brand: Optional[str] = None,
        max_results: int = 5,
    ) -> List[SearchResultItem]:
        """Run an ad-hoc search query for debugging or verification."""
        q = SearchQuery(
            query_text=query_text,
            target_brand=brand,
            max_results=max_results,
        )
        return await self.aggregator.search_provider.search(q)

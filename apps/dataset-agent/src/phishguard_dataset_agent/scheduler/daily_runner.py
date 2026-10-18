"""Daily runner and scheduling daemon for autonomous dataset aggregation."""

import asyncio
from datetime import datetime, timezone, timedelta
import logging
import signal
from typing import Any, Callable, Dict, Optional

from ..config import DatasetAgentConfig
from ..aggregator.dataset_aggregator import DatasetAggregator, AggregatedDatasetBatch
from ..storage.sink import DatasetSink

logger = logging.getLogger(__name__)


class DailyDatasetAgentScheduler:
    """Manages continuous daily deployment of the web search and dataset aggregator agent."""

    def __init__(
        self,
        config: Optional[DatasetAgentConfig] = None,
        aggregator: Optional[DatasetAggregator] = None,
        sink: Optional[DatasetSink] = None,
    ):
        self.config = config or DatasetAgentConfig()
        self.aggregator = aggregator or DatasetAggregator(self.config)
        self.sink = sink or DatasetSink(
            output_dir=self.config.output_dir,
            lifecycle_dataset_dir=self.config.lifecycle_dataset_dir,
            export_to_ml_lifecycle=self.config.export_to_ml_lifecycle,
        )

        self._is_running = False
        self._stop_event = asyncio.Event()
        self._last_run_time: Optional[datetime] = None
        self._next_run_time: Optional[datetime] = None
        self._cycles_completed = 0
        self._last_error: Optional[str] = None
        self._last_summary: Optional[Dict[str, Any]] = None

        # Hooks
        self.on_cycle_complete: Optional[Callable[[AggregatedDatasetBatch, Dict[str, Any]], None]] = None
        self.on_cycle_error: Optional[Callable[[Exception], None]] = None

    @property
    def is_running(self) -> bool:
        return self._is_running

    def get_status(self) -> Dict[str, Any]:
        """Return runtime heartbeat and execution metrics."""
        return {
            "is_running": self._is_running,
            "cycles_completed": self._cycles_completed,
            "last_run_time": self._last_run_time.isoformat() if self._last_run_time else None,
            "next_run_time": self._next_run_time.isoformat() if self._next_run_time else None,
            "last_error": self._last_error,
            "last_summary": self._last_summary,
            "interval_seconds": self.config.interval_seconds,
            "storage_status": self.sink.get_status(),
        }

    async def execute_cycle(self, date_str: Optional[str] = None) -> Dict[str, Any]:
        """Execute a single dataset aggregation and archiving cycle."""
        logger.info("Executing dataset agent cycle...")
        self._last_run_time = datetime.now(timezone.utc)
        self._last_error = None

        try:
            batch = await self.aggregator.run_aggregation_cycle(date_str=date_str)
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
            self._cycles_completed += 1
            self._last_summary = summary

            if self.on_cycle_complete:
                try:
                    self.on_cycle_complete(batch, summary)
                except Exception as hook_err:
                    logger.error("Error in on_cycle_complete hook: %s", hook_err)

            return summary

        except Exception as exc:
            self._last_error = str(exc)
            logger.exception("Dataset agent aggregation cycle failed: %s", exc)
            if self.on_cycle_error:
                try:
                    self.on_cycle_error(exc)
                except Exception:
                    pass
            raise

    def stop(self) -> None:
        """Signal the daemon loop to stop gracefully."""
        logger.info("Stopping dataset agent daemon...")
        self._is_running = False
        self._stop_event.set()

    def _calculate_sleep_duration(self) -> float:
        """Calculate seconds until next execution (defaulting to config interval)."""
        return float(self.config.interval_seconds)

    async def start(self, run_immediately: bool = True) -> None:
        """Start long-running daily scheduler daemon."""
        self._is_running = True
        self._stop_event.clear()
        logger.info(
            "PhishGuard Dataset Agent daemon started. Interval: %ds (target: %d samples/day).",
            self.config.interval_seconds,
            self.config.daily_sample_target,
        )

        # Wire OS termination signals if in main thread
        try:
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, self.stop)
        except (NotImplementedError, RuntimeError):
            pass

        try:
            while self._is_running and not self._stop_event.is_set():
                if run_immediately or self._cycles_completed > 0:
                    try:
                        await self.execute_cycle()
                    except Exception as err:
                        logger.error("Cycle failed with error: %s. Will retry at next schedule.", err)

                sleep_secs = self._calculate_sleep_duration()
                self._next_run_time = datetime.now(timezone.utc) + timedelta(seconds=sleep_secs)
                logger.info("Next cycle scheduled for %s (in %.1f hours). Sleeping...", self._next_run_time.isoformat(), sleep_secs / 3600.0)

                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_secs)
                    # Stop event triggered
                    break
                except asyncio.TimeoutError:
                    # Timeout reached, proceed to next cycle
                    continue

        finally:
            self._is_running = False
            logger.info("Dataset agent scheduler stopped.")

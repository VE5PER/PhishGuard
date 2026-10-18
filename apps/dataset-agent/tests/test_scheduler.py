"""Tests for daily dataset scheduler and DatasetAgent facade."""

import asyncio
import pytest
from phishguard_dataset_agent.config import DatasetAgentConfig
from phishguard_dataset_agent.scheduler.daily_runner import DailyDatasetAgentScheduler
from phishguard_dataset_agent.agent import DatasetAgent


def test_scheduler_single_cycle_execution(mock_agent_config: DatasetAgentConfig):
    async def _run():
        scheduler = DailyDatasetAgentScheduler(config=mock_agent_config)

        hook_called = False

        def hook_on_complete(batch, summary):
            nonlocal hook_called
            hook_called = True
            assert summary["total_samples"] == 10

        scheduler.on_cycle_complete = hook_on_complete

        summary = await scheduler.execute_cycle(date_str="2026-10-07")
        assert summary["date"] == "2026-10-07"
        assert summary["total_samples"] == 10
        assert hook_called is True

        status = scheduler.get_status()
        assert status["cycles_completed"] == 1
        assert status["last_run_time"] is not None
        assert status["storage_status"]["total_samples"] == 10

    asyncio.run(_run())


def test_dataset_agent_facade(mock_agent_config: DatasetAgentConfig):
    async def _run():
        agent = DatasetAgent(config=mock_agent_config)
        summary = await agent.run_once(sample_target=4, date_str="2026-10-07")
        assert summary["total_samples"] == 4

        status = agent.get_status()
        assert status["config"]["daily_sample_target"] == 10
        assert status["config"]["search_provider"] == "mock"

        search_items = await agent.test_search("Microsoft login", brand="Microsoft", max_results=2)
        assert len(search_items) == 2

    asyncio.run(_run())


def test_scheduler_stop_behavior(mock_agent_config: DatasetAgentConfig):
    async def _run():
        mock_agent_config.interval_seconds = 60
        scheduler = DailyDatasetAgentScheduler(config=mock_agent_config)

        # Launch daemon in background and stop it shortly
        task = asyncio.create_task(scheduler.start(run_immediately=False))
        await asyncio.sleep(0.05)
        assert scheduler.is_running is True

        scheduler.stop()
        await task
        assert scheduler.is_running is False

    asyncio.run(_run())

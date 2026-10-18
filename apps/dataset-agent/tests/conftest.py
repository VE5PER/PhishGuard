"""Pytest fixtures for dataset agent tests."""

import pytest
from pathlib import Path
from phishguard_dataset_agent.config import DatasetAgentConfig


@pytest.fixture
def temp_output_dir(tmp_path: Path) -> Path:
    out = tmp_path / "daily_datasets"
    out.mkdir(parents=True, exist_ok=True)
    return out


@pytest.fixture
def temp_lifecycle_dir(tmp_path: Path) -> Path:
    out = tmp_path / "lifecycle_sota"
    out.mkdir(parents=True, exist_ok=True)
    return out


@pytest.fixture
def mock_agent_config(temp_output_dir: Path, temp_lifecycle_dir: Path) -> DatasetAgentConfig:
    return DatasetAgentConfig(
        output_dir=temp_output_dir,
        lifecycle_dataset_dir=temp_lifecycle_dir,
        search_provider="mock",
        daily_sample_target=10,
        interval_seconds=3600,
        target_brands=["Microsoft", "Google", "PayPal"],
        export_to_ml_lifecycle=True,
    )

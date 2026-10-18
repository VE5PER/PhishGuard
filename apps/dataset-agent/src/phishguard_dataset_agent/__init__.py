"""PhishGuard Autonomous Dataset Agent.

Continuously deploys an autonomous agent to execute targeted web searches,
inspect online pages, and aggregate multimodal datasets (URL features,
DOM structure, brand logos, and synthetic interaction telemetry) every day
for PhishGuard multimodal model training.
"""

from .config import DatasetAgentConfig
from .agent import DatasetAgent
from .scheduler.daily_runner import DailyDatasetAgentScheduler

__version__ = "0.1.0"

__all__ = [
    "DatasetAgentConfig",
    "DatasetAgent",
    "DailyDatasetAgentScheduler",
    "__version__",
]

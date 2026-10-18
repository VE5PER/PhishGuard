"""Loader for the committed public source registry and connector map."""

import json
import logging
from pathlib import Path
from typing import Dict, List

from .models import SourceSpec
from .feeds import (
    BaseFeedConnector,
    OpenPhishFeed,
    TrancoTopSitesFeed,
    PhishingDatabaseFeed,
    SeedSnapshotFeed,
)

logger = logging.getLogger(__name__)

REGISTRY_PATH = Path(__file__).resolve().parent / "registry.json"


def load_registry(path: Path = REGISTRY_PATH) -> List[SourceSpec]:
    """Load and validate the committed source registry."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:
        logger.warning("Failed to load source registry from %s: %s", path, exc)
        return []
    return [SourceSpec.model_validate(entry) for entry in raw]


CONNECTORS: Dict[str, type[BaseFeedConnector]] = {
    "openphish": OpenPhishFeed,
    "tranco": TrancoTopSitesFeed,
    "phishing_database": PhishingDatabaseFeed,
    "seed_snapshot": SeedSnapshotFeed,
}

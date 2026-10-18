"""Curated playground scenarios (JSON payload templates plus mock screenshots)."""

import base64
import json
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from phishguard_types import EscalationPayload, PlaygroundScenario

SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"
SCENARIO_ORDER = ("brand-impersonation", "ambiguous-sso", "benign-google")
TEMPLATE_TIMESTAMP = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _screenshot_data_url(scenario_id: str) -> str:
    data = (SCENARIOS_DIR / f"{scenario_id}.jpg").read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def _load(scenario_id: str) -> PlaygroundScenario:
    raw = json.loads((SCENARIOS_DIR / f"{scenario_id}.json").read_text(encoding="utf-8"))
    payload = EscalationPayload.model_validate(
        {
            **raw["payload"],
            "telemetryId": str(uuid5(NAMESPACE_URL, f"phishguard-playground:{scenario_id}")),
            "clientRiskScore": 0.0,
            "clientTimestamp": TEMPLATE_TIMESTAMP.isoformat(),
            "screenshotBase64": _screenshot_data_url(scenario_id),
        }
    )
    return PlaygroundScenario(id=scenario_id, title=raw["title"], tagline=raw["tagline"], payload=payload)


@lru_cache(maxsize=1)
def load_scenarios() -> tuple[PlaygroundScenario, ...]:
    return tuple(_load(scenario_id) for scenario_id in SCENARIO_ORDER)


def get_scenario(scenario_id: str) -> PlaygroundScenario | None:
    return next((scenario for scenario in load_scenarios() if scenario.id == scenario_id), None)

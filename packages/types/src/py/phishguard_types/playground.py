"""Interactive playground data contracts in Pydantic v2."""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .inference import CloudInferenceVerdict, EscalationPayload
from .telemetry import DOMEvidenceSource, DOMInteractionEvent, KeystrokeDynamics, PointerEventPoint


class PlaygroundScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., pattern=r"^[a-z0-9-]+$")
    title: str
    tagline: str
    payload: EscalationPayload


class PlaygroundScenarioList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenarios: List[PlaygroundScenario]
    geminiConfigured: bool
    geminiModel: Optional[str] = None


class PlaygroundInteraction(BaseModel):
    """User-recorded behavior replayed against a server-fixed scenario page."""
    model_config = ConfigDict(extra="forbid")

    mouseTrajectorySeries: List[PointerEventPoint] = Field(..., min_length=1, max_length=128)
    keystrokesSummary: List[KeystrokeDynamics] = Field(default_factory=list, max_length=128)
    observedDomEvents: List[DOMInteractionEvent] = Field(default_factory=list, max_length=32)

    @field_validator("observedDomEvents")
    @classmethod
    def _only_observed_interactions(cls, events: List[DOMInteractionEvent]) -> List[DOMInteractionEvent]:
        if any(event.evidenceSource != DOMEvidenceSource.OBSERVED_INTERACTION for event in events):
            raise ValueError("evidenceSource must be observed_interaction")
        return events


class PlaygroundRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRiskScore: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    clientModelVersion: Optional[str] = None
    clientModelSha256: Optional[str] = Field(default=None, pattern=r"^[a-fA-F0-9]{64}$")
    clientInputContract: Optional[str] = None
    interaction: Optional[PlaygroundInteraction] = None


class TeacherToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    args: Dict[str, Any]
    result: Dict[str, Any]


class TeacherTraceStatus(str, Enum):
    OK = "ok"
    FALLBACK = "fallback"
    UNCONFIGURED = "unconfigured"
    CIRCUIT_OPEN = "circuit_open"
    BUDGET_EXHAUSTED = "budget_exhausted"


class TeacherTrace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: TeacherTraceStatus
    model: Optional[str] = None
    toolCalls: List[TeacherToolCall] = Field(default_factory=list)
    latencyMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    cached: bool
    fallbackReason: Optional[str] = None


class PlaygroundTeacherResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: CloudInferenceVerdict
    latencyMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    cached: bool


class PlaygroundGeminiResult(PlaygroundTeacherResult):
    trace: TeacherTrace


class PlaygroundRunResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: EscalationPayload
    evidence: PlaygroundTeacherResult
    gemini: PlaygroundGeminiResult

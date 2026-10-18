"""Inference and escalation data contracts in Pydantic v2."""

from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID
from pydantic import BaseModel, Field, HttpUrl, ConfigDict, field_validator

from .telemetry import PointerEventPoint, DOMInteractionEvent, KeystrokeDynamics


class TriStateAction(str, Enum):
    SAFE = "SAFE"
    AMBIGUOUS = "AMBIGUOUS"
    BLOCK = "BLOCK"


class ClientInferenceResult(BaseModel):
    """Result of on-device student model inference."""
    model_config = ConfigDict(extra="forbid")

    clientRiskScore: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        strict=True,
        allow_inf_nan=False,
        description="Fused operational risk score between 0 and 1",
    )
    routeAction: TriStateAction
    inferenceLatencyMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    evaluatedAt: datetime
    modelVersion: str = Field(..., min_length=1)


class EscalationPayload(BaseModel):
    """Payload dispatched to backend POST /v1/escalate when client score is in ambiguous zone [0.15, 0.85]."""
    model_config = ConfigDict(extra="forbid")

    telemetryId: UUID
    url: HttpUrl
    domain: str = Field(..., min_length=1)
    clientRiskScore: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    hasCredentialField: bool = Field(default=False, strict=True)
    clientModelVersion: Optional[str] = None
    clientModelSha256: Optional[str] = Field(default=None, pattern=r"^[a-fA-F0-9]{64}$")
    clientInputContract: Optional[str] = None
    screenshotBase64: Optional[str] = Field(
        default=None,
        max_length=2_100_000,
        pattern=r"^data:image/(webp|jpeg);base64,[A-Za-z0-9+/=]+$",
    )
    mouseTrajectorySeries: List[PointerEventPoint] = Field(default_factory=list)
    domElementsSummary: List[DOMInteractionEvent] = Field(default_factory=list)
    keystrokesSummary: List[KeystrokeDynamics] = Field(default_factory=list)
    clientTimestamp: datetime


class CloudActionOverride(str, Enum):
    ALLOW = "ALLOW"
    BLOCK = "BLOCK"
    WARN = "WARN"


class ScreenAnalysis(BaseModel):
    """Screen-content analysis of the consented viewport screenshot."""
    model_config = ConfigDict(extra="forbid")

    screenRiskScore: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    detectedBrand: Optional[str] = Field(default=None, max_length=64)
    credentialFormVisible: bool
    urgencyCues: List[str] = Field(default_factory=list, max_length=6)
    onScreenUrlMismatch: bool
    reasons: List[str] = Field(default_factory=list, max_length=6)

    @field_validator("urgencyCues")
    @classmethod
    def _urgency_cue_length(cls, cues: List[str]) -> List[str]:
        if any(len(cue) > 120 for cue in cues):
            raise ValueError("urgencyCues items must be at most 120 characters")
        return cues

    @field_validator("reasons")
    @classmethod
    def _reason_length(cls, reasons: List[str]) -> List[str]:
        if any(len(reason) > 300 for reason in reasons):
            raise ValueError("reasons items must be at most 300 characters")
        return reasons


class CloudInferenceVerdict(BaseModel):
    """Rich verdict returned by cloud parent teacher model."""
    model_config = ConfigDict(extra="forbid")

    analysisId: UUID
    telemetryId: UUID
    isPhishing: bool
    targetBrand: Optional[str] = None
    confidence: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    actionOverride: CloudActionOverride
    explanationReasons: List[str] = Field(default_factory=list)
    teacherModelVersion: str
    evaluatedAt: datetime
    riskScore: Optional[float] = Field(default=None, ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    screenAnalysis: Optional[ScreenAnalysis] = None

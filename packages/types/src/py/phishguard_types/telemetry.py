"""Interaction telemetry data contracts in Pydantic v2."""

from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID
from pydantic import BaseModel, Field, HttpUrl, ConfigDict


class PointerEventType(str, Enum):
    MOVE = "move"
    DOWN = "down"
    UP = "up"


class PointerEventPoint(BaseModel):
    """Single sampled pointer event with normalized kinematics."""
    model_config = ConfigDict(extra="forbid")

    x: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False, description="Normalized viewport x in range [0, 1]")
    y: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False, description="Normalized viewport y in range [0, 1]")
    dx: float = Field(..., strict=True, allow_inf_nan=False, description="Horizontal displacement from previous point in pixels")
    dy: float = Field(..., strict=True, allow_inf_nan=False, description="Vertical displacement from previous point in pixels")
    velocity: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Instantaneous velocity in px/ms")
    acceleration: float = Field(..., strict=True, allow_inf_nan=False, description="Instantaneous acceleration in px/ms^2")
    angle: float = Field(..., strict=True, allow_inf_nan=False, description="Trajectory direction angle in radians [-pi, pi]")
    timestamp: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Relative timestamp in ms since session start")
    eventType: PointerEventType = Field(..., description="Event type: move, down, or up")


class KeystrokeCategory(str, Enum):
    ALPHANUMERIC = "ALPHANUMERIC"
    BACKSPACE = "BACKSPACE"
    CONTROL = "CONTROL"
    OTHER = "OTHER"


class KeystrokeDynamics(BaseModel):
    """Privacy-preserving keystroke timings without raw characters."""
    model_config = ConfigDict(extra="forbid")

    category: KeystrokeCategory = Field(
        ...,
        description="GDPR-safe generalized key category; no raw key characters recorded"
    )
    dwellTimeMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Duration between keydown and keyup in ms")
    flightTimeMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Duration between previous keyup and current keydown in ms")
    timestamp: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Relative timestamp in ms")


class DOMInteractionType(str, Enum):
    CLICK = "click"
    PASTE = "paste"
    FOCUS = "focus"
    HOVER = "hover"


class DOMEvidenceSource(str, Enum):
    OBSERVED_INTERACTION = "observed_interaction"
    TOPOLOGY_SCAN = "topology_scan"
    LEGACY = "legacy"


class CoveredControlType(str, Enum):
    PASSWORD = "password"
    SUBMIT = "submit"
    OTHER = "other"
    NONE = "none"


class CredentialFrameEvidence(str, Enum):
    OBSERVED = "observed"
    UNVERIFIED = "unverified"
    NONE = "none"


class ElementBoundingBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(..., strict=True, allow_inf_nan=False)
    y: float = Field(..., strict=True, allow_inf_nan=False)
    width: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    height: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)


class DOMInteractionEvent(BaseModel):
    """Suspicious or relevant DOM topological interactions."""
    model_config = ConfigDict(extra="forbid")

    eventType: DOMInteractionType
    targetBoundingBox: ElementBoundingBox
    isZeroOpacity: bool = Field(..., strict=True, description="True if computed opacity is 0 or display is none")
    isCrossOriginIframe: bool = Field(..., strict=True, description="True if event interacted with cross-origin iframe")
    isPasswordInput: bool = Field(..., strict=True, description="True if target is password input")
    isPasteIntoPassword: bool = Field(..., strict=True, description="True if paste action targeted password field")
    elementSelector: str = Field(..., strict=True, description="Hierarchical DOM selector path")
    timestamp: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    evidenceSource: DOMEvidenceSource = DOMEvidenceSource.LEGACY
    evidenceId: Optional[str] = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$", strict=True)
    isHitTestIntercepting: bool = Field(default=False, strict=True)
    coveredControlType: CoveredControlType = CoveredControlType.NONE
    credentialFrameEvidence: CredentialFrameEvidence = CredentialFrameEvidence.NONE


class ScrollOffset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(default=0.0, ge=0.0, strict=True, allow_inf_nan=False)
    y: float = Field(default=0.0, ge=0.0, strict=True, allow_inf_nan=False)


class ViewportCaptureSpec(BaseModel):
    """Visual page snapshot captured on page idle."""
    model_config = ConfigDict(extra="forbid")

    width: int = Field(..., gt=0, strict=True)
    height: int = Field(..., gt=0, strict=True)
    mimeType: str = Field(..., pattern=r"^image\/(webp|jpeg|png)$", strict=True)
    base64Data: str = Field(..., min_length=1, strict=True)
    devicePixelRatio: float = Field(default=1.0, gt=0.0, strict=True, allow_inf_nan=False)
    scrollOffset: ScrollOffset = Field(default_factory=ScrollOffset)
    capturedAt: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)


class InteractionTelemetryPayload(BaseModel):
    """Full client telemetry payload."""
    model_config = ConfigDict(extra="forbid")

    telemetryId: UUID
    url: HttpUrl
    domain: str = Field(..., min_length=1, strict=True)
    pageTitle: str = Field(default="", strict=True)
    sessionDurationMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False)
    pointerSeries: List[PointerEventPoint] = Field(default_factory=list)
    keystrokes: List[KeystrokeDynamics] = Field(default_factory=list)
    domEvents: List[DOMInteractionEvent] = Field(default_factory=list)
    viewportCapture: Optional[ViewportCaptureSpec] = None
    hasCredentialField: bool = Field(default=False, strict=True)
    clientTimestamp: datetime

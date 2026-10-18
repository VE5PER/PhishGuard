"""Dataset and SOTA benchmark schemas in Pydantic v2."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Literal, Optional
from uuid import UUID
from pydantic import BaseModel, Field, ConfigDict

from .telemetry import (
    PointerEventPoint,
    KeystrokeDynamics,
    DOMInteractionEvent,
    ViewportCaptureSpec,
    ElementBoundingBox,
)


class TargetBrandClass(str, Enum):
    MICROSOFT = "Microsoft"
    GOOGLE = "Google"
    APPLE = "Apple"
    PAYPAL = "PayPal"
    BANK_OF_AMERICA = "Bank of America"
    AMAZON = "Amazon"
    FACEBOOK = "Facebook"
    NETFLIX = "Netflix"
    CHASE = "Chase"
    WELLS_FARGO = "Wells Fargo"
    ADOBE = "Adobe"
    YAHOO = "Yahoo"
    EBAY = "eBay"
    STEAM = "Steam"
    LINKEDIN = "LinkedIn"
    DHL = "DHL"
    DROPBOX = "Dropbox"
    DOCUSIGN = "DocuSign"
    COINBASE = "Coinbase"
    WHATSAPP = "WhatsApp"
    GENERIC_BENIGN = "Generic Benign"
    NONE = "None"


class VisualElementType(str, Enum):
    LOGO = "logo"
    INPUT_CREDENTIAL = "input_credential"
    INPUT_GENERIC = "input_generic"
    BUTTON_SUBMIT = "button_submit"
    SECURITY_BADGE = "security_badge"
    CAPTCHA = "captcha"


class LogoGroundingSpec(BaseModel):
    """Detected or ground-truth brand logo on screen with identity alignment."""
    model_config = ConfigDict(extra="forbid")

    brandName: TargetBrandClass
    brandId: int = Field(..., ge=0, description="Numerical index of target brand")
    boundingBox: ElementBoundingBox
    confidence: float = Field(..., ge=0.0, le=1.0)
    domainMatchesBrand: bool = Field(..., description="True if domain is an official domain for this brand")


class ImageDetectionAnnotation(BaseModel):
    """Visual UI object detection annotation on screen."""
    model_config = ConfigDict(extra="forbid")

    category: VisualElementType
    boundingBox: ElementBoundingBox
    confidence: float = Field(..., ge=0.0, le=1.0)


class DatasetProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    sourceType: Literal["repository_fixture", "synthetic", "mock", "fetched_metadata", "public_feed", "research_agent", "unknown"]
    labelSource: Literal["manual_fixture", "synthetic_scenario", "heuristic", "verified_feed", "llm_research", "unknown"]
    labelConfidence: float = Field(ge=0, le=1)
    labelReason: str = Field(max_length=256)
    baseSampleId: Optional[str] = Field(default=None, max_length=256)
    groupId: Optional[str] = Field(default=None, max_length=256)
    modalities: Dict[str, Literal["observed", "synthetic", "missing"]] = Field(default_factory=dict)


class MultimodalDatasetSample(BaseModel):
    """Complete multimodal dataset sample spanning URL, HID, Logo, Screen, and Image Detection."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    sampleId: UUID
    label: float = Field(..., ge=0.0, le=1.0, description="0.0 = Benign, 1.0 = Phishing")
    url: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    targetBrand: Optional[TargetBrandClass] = None
    pointerSeries: List[PointerEventPoint] = Field(default_factory=list)
    keystrokes: List[KeystrokeDynamics] = Field(default_factory=list)
    domEvents: List[DOMInteractionEvent] = Field(default_factory=list)
    viewportCapture: Optional[ViewportCaptureSpec] = None
    logoDetections: List[LogoGroundingSpec] = Field(default_factory=list)
    imageDetections: List[ImageDetectionAnnotation] = Field(default_factory=list)
    extractedFeatures: Optional[Dict[str, List[float]]] = None
    createdAt: datetime
    provenance: Optional[DatasetProvenance] = None


class DatasetSplitStats(BaseModel):
    """Statistics for a specific dataset split."""
    model_config = ConfigDict(extra="forbid")

    totalSamples: int = Field(..., ge=0)
    phishingSamples: int = Field(..., ge=0)
    benignSamples: int = Field(..., ge=0)
    samplesWithLogo: int = Field(..., ge=0)
    samplesWithScreenshot: int = Field(..., ge=0)


class DatasetManifest(BaseModel):
    """Comprehensive dataset manifest storing split distributions, modalities, and SOTA thresholds."""
    model_config = ConfigDict(extra="forbid")

    datasetName: str
    datasetVersion: str
    createdAt: str
    totalSamples: int = Field(..., ge=0)
    splits: Dict[str, DatasetSplitStats]
    modalitiesSupported: List[str]
    sotaBenchmarkTargets: Dict[str, float]
    featureDimensions: Dict[str, int]


class SOTABenchmarkReport(BaseModel):
    """Report verifying trained model performance against industry SOTA benchmarks."""
    model_config = ConfigDict(extra="forbid")

    modelName: str
    evaluatedAt: str
    datasetVersion: str
    passedSotaBenchmark: bool
    accuracy: float = Field(..., ge=0.0, le=1.0)
    precision: float = Field(..., ge=0.0, le=1.0)
    recall: float = Field(..., ge=0.0, le=1.0)
    f1Score: float = Field(..., ge=0.0, le=1.0)
    falsePositiveRate: float = Field(..., ge=0.0, le=1.0)
    rocAuc: float = Field(..., ge=0.0, le=1.0)
    brierScore: float = Field(..., ge=0.0, le=1.0)
    latencyMsAvg: float = Field(..., ge=0.0)
    benchmarkThresholds: Dict[str, float]
    gateFailures: List[str] = Field(default_factory=list)

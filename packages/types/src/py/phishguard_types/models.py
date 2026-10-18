"""Model metadata, versioning, and sync schemas in Pydantic v2."""

from datetime import datetime
from enum import Enum
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, ConfigDict, conint


class ModelInputTensor(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    dtype: Literal["float32"]
    shape: List[conint(strict=True, gt=0)] = Field(..., min_length=1)


class ModelInputContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    identifier: str
    trajectoryPreprocessing: str
    inputs: List[ModelInputTensor]
    contextFeatures: List[str]


class ModelValidationSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    passedAllGates: bool
    modelSha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    corpusDigest: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    reportSha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    inputContractIdentifier: str
    policyVersion: str
    basis: Literal["repository_synthetic"]
    falsePositiveRate: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    benignWarningCount: int = Field(..., ge=0, strict=True)
    criticalMissCount: int = Field(..., ge=0, strict=True)
    independentTestGroups: int = Field(..., gt=0, strict=True)


class ModelMetrics(BaseModel):
    """Evaluation metrics for a registered model checkpoint."""
    model_config = ConfigDict(extra="forbid")

    accuracy: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False, description="Validation accuracy score")
    f1Score: float = Field(..., ge=0.0, le=1.0, strict=True, allow_inf_nan=False, description="Validation F1 score")
    latencyMs: float = Field(..., ge=0.0, strict=True, allow_inf_nan=False, description="Average inference latency in ms")
    memoryBudgetMb: float = Field(..., gt=0.0, strict=True, allow_inf_nan=False, description="Peak runtime memory footprint in MB")


class ModelMetadata(BaseModel):
    """Cryptographic and architectural metadata for versioned ONNX student models."""
    model_config = ConfigDict(extra="forbid")

    version: str = Field(..., min_length=1, description="SemVer version tag, e.g. 1.1.0")
    name: str = Field(..., min_length=1, description="Human-readable model name")
    architecture: str = Field(..., min_length=1, description="Model architecture type")
    sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$", description="SHA-256 hex cryptographic checksum")
    fileSizeBytes: int = Field(..., gt=0, description="Binary file size in bytes")
    releasedAt: datetime = Field(..., description="Release ISO timestamp")
    minExtensionVersion: str = Field(default="0.1.0", description="Minimum compatible extension version")
    features: List[str] = Field(
        default_factory=lambda: ["x", "y", "dx", "dy", "v", "theta"],
        description="Names of input tensor kinematic features"
    )
    metrics: ModelMetrics
    changelog: List[str] = Field(default_factory=list)
    downloadUrl: str = Field(..., min_length=1, description="Relative or absolute URL to download ONNX binary")
    inputContract: Optional[ModelInputContract] = None
    validationSummary: Optional[ModelValidationSummary] = None


class ModelSyncState(str, Enum):
    ONLINE_SYNCED = "ONLINE_SYNCED"
    ONLINE_UPDATE_AVAILABLE = "ONLINE_UPDATE_AVAILABLE"
    OFFLINE_FALLBACK = "OFFLINE_FALLBACK"
    UPDATING = "UPDATING"
    SYNC_ERROR = "SYNC_ERROR"


class ModelSource(str, Enum):
    REMOTE_SYNCED = "REMOTE_SYNCED"
    LOCAL_BUNDLED = "LOCAL_BUNDLED"
    CACHE_STORAGE = "CACHE_STORAGE"


class ModelSyncStatus(BaseModel):
    """Synchronization state reported by the client extension."""
    model_config = ConfigDict(extra="forbid")

    currentVersion: str
    latestAvailableVersion: str
    isLatest: bool
    lastSyncAttempt: datetime
    syncState: ModelSyncState
    backendReachable: bool
    modelSource: ModelSource
    activeMetadata: Optional[ModelMetadata] = None


class CheckUpdateRequest(BaseModel):
    """Payload sent by client when checking for model updates."""
    model_config = ConfigDict(extra="forbid")

    currentVersion: str = Field(..., description="Currently active client model SemVer")
    currentSha256: Optional[str] = Field(None, description="SHA-256 hash of active client model")
    extensionVersion: Optional[str] = None
    supportedInputContracts: Optional[List[str]] = None


class CheckUpdateResponse(BaseModel):
    """Response returned when client checks for newer models."""
    model_config = ConfigDict(extra="forbid")

    updateAvailable: bool
    currentVersion: str
    latestMetadata: ModelMetadata

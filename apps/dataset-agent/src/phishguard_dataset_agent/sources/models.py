"""Data models for public source registry and feed records."""

from typing import Literal, Optional
from pydantic import BaseModel, Field, ConfigDict


class SourceSpec(BaseModel):
    """Curated catalog entry describing a public phishing data source."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    kind: Literal["url_feed", "top_sites", "dataset", "threat_intel_api"]
    homepage: Optional[str] = None
    access_url: Optional[str] = None
    format: Optional[str] = None
    labels: Literal["phishing", "benign", "malware", "mixed"]
    trust: Literal["verified_feed", "community", "research"]
    auth_required: bool = False
    connector: Optional[str] = None
    terms_url: Optional[str] = None
    notes: Optional[str] = None


class FeedRecord(BaseModel):
    """Single URL observation emitted by a feed connector."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(..., min_length=1)
    label: float = Field(..., description="0.0 = benign, 1.0 = phishing")
    source_id: str = Field(..., min_length=1)
    label_confidence: float = Field(..., ge=0.0, le=1.0)
    label_reason: str = Field(default="", max_length=256)
    target_brand: Optional[str] = None

"""Data models for the Deep Research discovery stage.

These stay schema-simple (no Field bounds) because CuratedResearchBatch is sent
to Gemini as an output schema; truncation happens after parsing.
"""

from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


class CuratedRecord(BaseModel):
    """A URL the curator extracted from a Deep Research report, with citation."""

    model_config = ConfigDict(extra="forbid")

    url: str
    claimed_label: Literal["phishing", "benign"]
    target_brand: Optional[str] = None
    evidence: str = ""
    citation_url: Optional[str] = None
    topic_id: str = ""


class DiscoveredSource(BaseModel):
    """A public dataset/feed/benchmark surfaced by Deep Research."""

    model_config = ConfigDict(extra="forbid")

    name: str
    homepage: Optional[str] = None
    kind: Optional[str] = None
    labels: Optional[str] = None
    access_notes: Optional[str] = None


class CuratedResearchBatch(BaseModel):
    """Structured curator output for all research reports of a cycle."""

    model_config = ConfigDict(extra="forbid")

    records: List[CuratedRecord] = Field(default_factory=list)
    discovered_sources: List[DiscoveredSource] = Field(default_factory=list)


class ResearchTopic(BaseModel):
    """Seeded research topic descriptor."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    prompt_focus: str
    brands: Optional[List[str]] = None


class ResearchReport(BaseModel):
    """Raw result of a Deep Research interaction."""

    model_config = ConfigDict(extra="forbid")

    interaction_id: Optional[str] = None
    status: str
    text: str = ""


class ProcessedUrlFinding(BaseModel):
    """A research finding after refang/normalization, ready for sampling."""

    model_config = ConfigDict(extra="forbid")

    url: str
    label: float
    target_brand: Optional[str] = None
    evidence: str = ""
    citation_url: Optional[str] = None
    topic_id: str = ""


class ResearchCycleResult(BaseModel):
    """Output of one Deep Research collection pass."""

    model_config = ConfigDict(extra="forbid")

    findings: List[ProcessedUrlFinding] = Field(default_factory=list)
    discovered_sources: List[DiscoveredSource] = Field(default_factory=list)
    interactions: List[dict] = Field(default_factory=list)
    reports: List[dict] = Field(default_factory=list)

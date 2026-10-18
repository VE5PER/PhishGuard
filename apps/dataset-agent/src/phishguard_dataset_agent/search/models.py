"""Data models for web search operations."""

from datetime import datetime, timezone
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


class SearchQuery(BaseModel):
    """Specification of a web search query formulated by the dataset agent."""

    model_config = ConfigDict(extra="forbid")

    query_text: str = Field(..., min_length=1, description="Raw query string dispatched to search engine")
    target_brand: Optional[str] = Field(None, description="Associated brand being investigated, if any")
    intent: str = Field(
        default="phishing_discovery",
        description="Search intent: 'phishing_discovery' or 'benign_anchor'",
    )
    max_results: int = Field(default=10, ge=1, le=100)


class SearchResultItem(BaseModel):
    """Single URL result retrieved from a search engine."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(..., min_length=1, description="URL returned by search result")
    title: str = Field(default="", description="Web page title in search result")
    snippet: str = Field(default="", description="Search snippet text")
    engine: str = Field(default="search", description="Search engine identity (e.g. duckduckgo, serpapi, mock)")
    target_brand: Optional[str] = Field(None, description="Brand name associated with query")
    intent: str = Field(default="phishing_discovery", description="Origin query intent")
    discovered_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="Timestamp when result was gathered",
    )


class WebSearchBatch(BaseModel):
    """Collection of search results for a specific query."""

    model_config = ConfigDict(extra="forbid")

    query: SearchQuery
    items: List[SearchResultItem] = Field(default_factory=list)
    collected_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )

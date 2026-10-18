"""Data models for page collection and inspection."""

from datetime import datetime, timezone
from typing import Dict, Optional
from pydantic import BaseModel, Field, ConfigDict


class FetchedPageMetadata(BaseModel):
    """Metadata and structural DOM hints extracted during URL inspection."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(..., min_length=1)
    final_url: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    status_code: int = Field(default=200)
    title: str = Field(default="")
    forms_count: int = Field(default=0)
    password_inputs_count: int = Field(default=0)
    has_login_form: bool = Field(default=False)
    ssl_valid: bool = Field(default=True)
    headers: Dict[str, str] = Field(default_factory=dict)
    text_snippet: str = Field(default="")
    fetch_error: Optional[str] = None
    fetched_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )

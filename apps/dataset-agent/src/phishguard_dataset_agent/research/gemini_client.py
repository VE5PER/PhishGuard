"""Gemini API client for Deep Research (Interactions API background tasks)."""

import asyncio
import logging
import time
from typing import Protocol

from .models import ResearchReport

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = {"failed", "cancelled", "incomplete", "budget_exceeded"}

class ResearchClient(Protocol):
    """Interface for Deep Research report generation."""

    async def run_deep_research(
        self,
        prompt: str,
        timeout_s: int,
        poll_s: float = 15.0,
    ) -> ResearchReport:
        """Start a background Deep Research interaction and poll to completion."""
        ...


class GeminiResearchClient:
    """Gemini (API-key) implementation of ResearchClient."""

    def __init__(
        self,
        api_key: str,
        agent: str = "deep-research-preview-04-2026",
    ):
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self.agent = agent

    async def run_deep_research(
        self,
        prompt: str,
        timeout_s: int,
        poll_s: float = 15.0,
    ) -> ResearchReport:
        interactions = self._client.aio.interactions
        created = await interactions.create(
            agent=self.agent,
            input=prompt,
            agent_config={
                "type": "deep-research",
                "thinking_summaries": "none",
                "visualization": "off",
            },
            background=True,
        )
        interaction_id = getattr(created, "id", None)
        if not interaction_id:
            return ResearchReport(interaction_id=None, status="failed", text="")

        deadline = time.monotonic() + timeout_s
        while True:
            interaction = await interactions.get(interaction_id)
            status = str(getattr(interaction, "status", "") or "unknown")
            if status == "completed":
                return ResearchReport(
                    interaction_id=interaction_id,
                    status=status,
                    text=self._extract_text(interaction),
                )
            if status in TERMINAL_STATUSES:
                errors = getattr(interaction, "errors", None)
                logger.warning("Deep Research interaction %s ended %s: %s", interaction_id, status, errors)
                return ResearchReport(interaction_id=interaction_id, status=status, text="")
            if time.monotonic() >= deadline:
                return ResearchReport(interaction_id=interaction_id, status="timeout", text="")
            await asyncio.sleep(poll_s)

    @staticmethod
    def _extract_text(interaction) -> str:
        text = getattr(interaction, "output_text", None)
        if text:
            return text
        steps = getattr(interaction, "steps", None) or []
        for step in reversed(steps):
            parts = [
                getattr(c, "text", "")
                for c in (getattr(step, "content", None) or [])
                if getattr(c, "text", None)
            ]
            if parts:
                return "\n".join(parts)
        return ""

"""Deep Research collector: ADK pipeline (Deep Research gatherer + LLM curator) and finding normalization."""

import json
import logging
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import DatasetAgentConfig
from ..sources.feeds import normalize_candidate_url, host_of
from ..sources.registry import load_registry
from ..sources.models import SourceSpec
from . import adk_pipeline
from .gemini_client import GeminiResearchClient, ResearchClient
from .models import (
    CuratedRecord,
    CuratedResearchBatch,
    DiscoveredSource,
    ProcessedUrlFinding,
    ResearchCycleResult,
    ResearchTopic,
)

logger = logging.getLogger(__name__)

TOPICS_PATH = Path(__file__).resolve().parent.parent / "sources" / "seeds" / "research_topics.json"

DEEP_RESEARCH_PROMPT = """You are assisting PhishGuard, a defensive phishing-detection research project that builds labeled datasets of phishing and legitimate web pages for model training.

Research focus: {title}
{prompt_focus}
{brand_line}
Already-known public sources (do not re-report these as new sources): {known_sources}

Deliverables:
1. Public phishing URLs or domains that are explicitly listed as indicators of compromise (IOCs) in public, reputable sources published within the last 90 days (threat-intelligence vendor reports, CERT/government advisories, abuse feeds, academic datasets). For each, give: the URL in defanged form (hxxp/hxxps and [.] in the hostname), whether the source classifies it as phishing or as a legitimate page, the impersonated brand if stated, a one-sentence evidence summary, and the citation URL of the public source.
2. Public datasets, feeds, or benchmarks relevant to phishing-page detection (URLs, HTML, screenshots, or logos) that are not in the known list above. For each, give: name, homepage URL, kind (url_feed, top_sites, dataset, or threat_intel_api), label types (phishing, benign, malware, or mixed), and access notes (license, registration, or API-key requirements).

Rules:
- Only report URLs that appear verbatim in a cited public source. Never construct, guess, or extrapolate URLs or domains.
- Do not visit, submit data to, or interact with suspected phishing pages; rely on published reports.
- If you cannot find qualifying items for a deliverable, say so explicitly rather than estimating.
- Use plain text with one item per line; no charts or images."""


def _strip_fences(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    return text.strip()


def load_research_topics(path: Path = TOPICS_PATH) -> List[ResearchTopic]:
    """Load seeded research topics."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:
        logger.warning("Failed to load research topics from %s: %s", path, exc)
        return []
    return [ResearchTopic.model_validate(t) for t in raw]


class DeepResearchCollector:
    """Runs seeded Deep Research topics and normalizes extracted findings."""

    def __init__(
        self,
        config: DatasetAgentConfig,
        client: Optional[ResearchClient] = None,
        registry: Optional[List[SourceSpec]] = None,
        topics: Optional[List[ResearchTopic]] = None,
        curator_model: Any = None,
    ):
        self.config = config
        self.client = client
        self.registry = registry if registry is not None else load_registry()
        self.topics = topics if topics is not None else load_research_topics()
        self.curator_model = curator_model

    def _build_client(self) -> Optional[ResearchClient]:
        if self.client is not None:
            return self.client
        if not self.config.gemini_api_key:
            return None
        try:
            return GeminiResearchClient(
                api_key=self.config.gemini_api_key,
                agent=self.config.deep_research_agent,
            )
        except Exception as exc:
            logger.warning("Failed to initialize Gemini research client: %s", exc)
            return None

    def pick_topics(self, date_str: str, count: int) -> List[ResearchTopic]:
        """Deterministically pick `count` topics for the given date."""
        if not self.topics or count <= 0:
            return []
        try:
            ordinal = date.fromisoformat(date_str).toordinal()
        except ValueError:
            ordinal = date.today().toordinal()
        start = ordinal % len(self.topics)
        n = min(count, len(self.topics))
        return [self.topics[(start + i) % len(self.topics)] for i in range(n)]

    def build_prompt(self, topic: ResearchTopic) -> str:
        """Render the Deep Research prompt for a topic."""
        text = topic.title + " " + topic.prompt_focus
        brands = topic.brands or (self.config.target_brands[:5] if "{brand}" in text else [])
        brand_str = ", ".join(brands)
        title = topic.title.replace("{brand}", brand_str)
        focus = topic.prompt_focus.replace("{brand}", brand_str)
        brand_line = f"Brands of interest: {brand_str}." if brands else ""
        known_sources = ", ".join(s.name for s in self.registry)
        return DEEP_RESEARCH_PROMPT.format(
            title=title,
            prompt_focus=focus,
            brand_line=brand_line,
            known_sources=known_sources,
        )

    async def _run_pipeline(
        self,
        gatherer: adk_pipeline.ResearchGatherer,
        feed_index: Optional[Dict[str, Any]],
    ) -> str:
        """Single network seam: runs gatherer + curator and returns the curator's JSON text."""
        curator = adk_pipeline.build_curator(
            self.curator_model or self.config.extraction_model, api_key=self.config.gemini_api_key
        )
        return await adk_pipeline.run_pipeline(gatherer, curator, feed_index)

    async def collect(
        self,
        date_str: str,
        topics_override: Optional[List[ResearchTopic]] = None,
        feed_index: Optional[Dict[str, Any]] = None,
    ) -> ResearchCycleResult:
        """Run research for the day's topics through the ADK pipeline. Never raises."""
        client = self._build_client()
        topics = (
            topics_override
            if topics_override is not None
            else self.pick_topics(date_str, self.config.deep_research_tasks_per_cycle)
        )
        if client is None or not topics:
            return ResearchCycleResult()

        gatherer = adk_pipeline.ResearchGatherer(
            name=adk_pipeline.GATHERER_NAME,
            client=client,
            topic_prompts=[{"topic_id": t.id, "prompt": self.build_prompt(t)} for t in topics],
            timeout_s=self.config.deep_research_timeout_seconds,
        )
        batch = CuratedResearchBatch()
        try:
            text = await self._run_pipeline(gatherer, feed_index)
            batch = CuratedResearchBatch.model_validate_json(_strip_fences(text) or "{}")
        except Exception as exc:
            logger.warning("Research curation failed (%s)", type(exc).__name__)

        findings: List[ProcessedUrlFinding] = []
        for record in batch.records:
            processed = self._process_finding(record, record.topic_id)
            if processed:
                findings.append(processed)
        return ResearchCycleResult(
            findings=self._dedupe_and_cap(findings),
            discovered_sources=self._filter_known_sources(batch.discovered_sources),
            interactions=list(gatherer.interactions),
            reports=list(gatherer.reports),
        )

    def _process_finding(self, finding: CuratedRecord, topic_id: str) -> Optional[ProcessedUrlFinding]:
        """Refang/normalize a reported URL; drop uncited or non-http items."""
        if not finding.citation_url:
            return None
        url = normalize_candidate_url(finding.url)
        if not url:
            return None
        return ProcessedUrlFinding(
            url=url,
            label=1.0 if finding.claimed_label == "phishing" else 0.0,
            target_brand=finding.target_brand,
            evidence=(finding.evidence or "")[:200],
            citation_url=finding.citation_url,
            topic_id=topic_id,
        )

    def _dedupe_and_cap(self, findings: List[ProcessedUrlFinding]) -> List[ProcessedUrlFinding]:
        seen = set()
        out: List[ProcessedUrlFinding] = []
        for f in findings:
            key = f.url.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(f)
            if len(out) >= self.config.deep_research_max_urls:
                break
        return out

    def _filter_known_sources(self, discovered: List[DiscoveredSource]) -> List[DiscoveredSource]:
        known_hosts = set()
        for spec in self.registry:
            for url in (spec.homepage, spec.access_url):
                host = host_of(url) if url else None
                if host:
                    known_hosts.add(host)
        out = []
        for src in discovered:
            host = host_of(src.homepage) if src.homepage else None
            if host and host in known_hosts:
                continue
            out.append(src)
        return out

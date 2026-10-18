"""Aggregator module for coordinating web search, page inspection, and sample compilation."""

import asyncio
from datetime import datetime, timezone
import logging
import random
from typing import Any, Dict, List, Optional, Set
from pydantic import BaseModel, Field, ConfigDict

from phishguard_types import MultimodalDatasetSample, TargetBrandClass
from phishguard_types.dataset import DatasetProvenance
from ..config import DatasetAgentConfig
from ..search.query_generator import DatasetQueryGenerator
from ..search.providers import CompositeSearchProvider, BaseSearchProvider
from ..search.models import SearchResultItem
from ..collector.models import FetchedPageMetadata
from ..collector.page_fetcher import PageFetcher
from ..collector.labeler import HeuristicDatasetLabeler
from ..collector.sample_builder import DatasetSampleBuilder, BRAND_MAP
from ..sources.models import FeedRecord
from ..sources.feeds import BaseFeedConnector, SeedSnapshotFeed, TrancoTopSitesFeed, host_of
from ..sources.registry import load_registry, CONNECTORS
from ..research.corroboration import FeedIndex, build_feed_index, corroborate
from ..research.deep_research import DeepResearchCollector
from ..research.models import ProcessedUrlFinding

logger = logging.getLogger(__name__)


class AggregatedDatasetBatch(BaseModel):
    """Result of an aggregation cycle."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid")

    date: str
    samples: List[MultimodalDatasetSample]
    total_samples: int
    phishing_count: int
    benign_count: int
    unknown_count: int = 0
    queries_executed: int
    urls_inspected: int
    engines_used: List[str]
    feeds_used: List[str] = Field(default_factory=list)
    research: Optional[Dict[str, Any]] = None
    duration_seconds: float
    completed_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )


class DatasetAggregator:
    """Aggregates daily multimodal dataset samples through web exploration."""

    def __init__(
        self,
        config: DatasetAgentConfig,
        search_provider: Optional[BaseSearchProvider] = None,
        feed_connectors: Optional[List[BaseFeedConnector]] = None,
        research_collector: Optional[DeepResearchCollector] = None,
    ):
        self.config = config
        self.query_generator = DatasetQueryGenerator(
            target_brands=config.target_brands,
            seed=config.random_seed,
        )
        self.search_provider = search_provider or CompositeSearchProvider(
            provider_name=config.search_provider,
            api_key=config.search_api_key,
            timeout=config.request_timeout_seconds,
        )
        is_mock = (config.search_provider == "mock")
        self.fetcher = PageFetcher(timeout=config.request_timeout_seconds, mock_mode=is_mock)
        self.labeler = HeuristicDatasetLabeler()
        self.builder = DatasetSampleBuilder(seed=config.random_seed)
        self.is_mock = is_mock
        self._feed_connectors = feed_connectors
        self._research_collector = research_collector

    def _build_feed_connectors(self) -> List[BaseFeedConnector]:
        if self._feed_connectors is not None:
            return self._feed_connectors
        registry_by_id = {s.id: s for s in load_registry()}
        connectors: List[BaseFeedConnector] = []
        for source_id in self.config.feed_sources:
            spec = registry_by_id.get(source_id)
            if not spec:
                logger.warning("Feed source '%s' not found in source registry; skipping", source_id)
                continue
            if not spec.connector:
                logger.warning("Feed source '%s' has no connector implementation; skipping", source_id)
                continue
            connector_cls = CONNECTORS.get(spec.connector)
            if not connector_cls:
                logger.warning("No connector class registered for '%s'; skipping", spec.connector)
                continue
            kwargs: Dict[str, Any] = {"timeout": self.config.request_timeout_seconds}
            if connector_cls is TrancoTopSitesFeed:
                kwargs["top_n"] = self.config.tranco_top_n
            connectors.append(connector_cls(**kwargs))
        return connectors

    def _build_research_collector(self) -> Optional[DeepResearchCollector]:
        if self._research_collector is not None:
            return self._research_collector
        if not self.config.deep_research_enabled or not self.config.gemini_api_key:
            return None
        return DeepResearchCollector(config=self.config)

    async def run_aggregation_cycle(
        self,
        sample_target: Optional[int] = None,
        date_str: Optional[str] = None,
    ) -> AggregatedDatasetBatch:
        """Run an end-to-end dataset aggregation cycle."""
        start_time = datetime.now(timezone.utc)
        target = sample_target or self.config.daily_sample_target
        if not date_str:
            date_str = start_time.strftime("%Y-%m-%d")

        logger.info("Starting daily dataset aggregation cycle for %s (target: %d samples)...", date_str, target)

        research_task: Optional[asyncio.Task] = None
        feed_index: Optional[FeedIndex] = None
        collector = None if self.is_mock else self._build_research_collector()

        desired_phish = int(target * self.config.phishing_target_ratio)
        desired_benign = max(1, target - desired_phish)
        fetch_semaphore = asyncio.Semaphore(self.config.fetch_concurrency)

        phishing_samples: List[MultimodalDatasetSample] = []
        benign_samples: List[MultimodalDatasetSample] = []
        unknown_samples: List[MultimodalDatasetSample] = []
        seen_urls: Set[str] = set()
        feeds_used: List[str] = []

        # Public feed connectors (skipped entirely in mock mode).
        if not self.is_mock:
            feed_records = await self._gather_feed_records(feeds_used, date_str, target)
            feed_index = build_feed_index(feed_records)
            # Deep Research overlaps search and probing (never blocks the cycle on failure).
            if collector is not None:
                research_task = asyncio.create_task(collector.collect(date_str, feed_index=feed_index))
            phish_hosts = {host_of(r.url) for r in feed_records if r.label > 0.5}
            phish_hosts.discard(None)
            feed_chunk = max(1, self.config.fetch_concurrency)
            for start in range(0, len(feed_records), feed_chunk):
                if len(phishing_samples) >= desired_phish and len(benign_samples) >= desired_benign:
                    break
                selected: List[tuple] = []
                pending_phish = pending_benign = 0
                for record in feed_records[start : start + feed_chunk]:
                    if (len(phishing_samples) + pending_phish >= desired_phish
                            and len(benign_samples) + pending_benign >= desired_benign):
                        break
                    norm = record.url.strip().lower()
                    if norm in seen_urls:
                        continue
                    host = host_of(record.url)
                    if not host:
                        continue
                    if record.label > 0.5:
                        if len(phishing_samples) + pending_phish >= desired_phish:
                            continue
                        pending_phish += 1
                    else:
                        if len(benign_samples) + pending_benign >= desired_benign:
                            continue
                        # Shared-hosting guard: skip benign anchors that host phishing content.
                        if any(host == h or host.endswith("." + h) or h.endswith("." + host) for h in phish_hosts):
                            continue
                        pending_benign += 1
                    selected.append((record, host))
                    seen_urls.add(norm)
                built = await asyncio.gather(
                    *(self._build_feed_sample(r, h, "public_feed", fetch_semaphore) for r, h in selected)
                )
                for (record, _), sample in zip(selected, built):
                    if record.label > 0.5:
                        phishing_samples.append(sample)
                    else:
                        benign_samples.append(sample)

        # 1. Formulate search queries
        num_queries = max(6, (target // 5) + 4)
        queries = self.query_generator.generate_daily_query_batch(
            phishing_ratio=self.config.phishing_target_ratio,
            total_queries=num_queries,
            max_results_per_query=self.config.max_search_results_per_query,
        )

        # 2. Execute web searches in parallel with concurrency limiter
        all_results: List[SearchResultItem] = []
        engines_used: Set[str] = set()

        async def _execute_query(q):
            try:
                res = await self.search_provider.search(q)
                for item in res:
                    engines_used.add(item.engine)
                return res
            except Exception as e:
                logger.warning("Query execution failed for '%s': %s", q.query_text, e)
                return []

        search_tasks = [_execute_query(q) for q in queries]
        batch_results = await asyncio.gather(*search_tasks)
        for sub_res in batch_results:
            all_results.extend(sub_res)

        # 3. Deduplicate discovered URLs
        deduped_items: List[SearchResultItem] = []
        for it in all_results:
            norm_url = it.url.strip().lower()
            if norm_url not in seen_urls:
                seen_urls.add(norm_url)
                deduped_items.append(it)

        logger.info("Gathered %d unique URLs across %d queries.", len(deduped_items), len(queries))

        # 4. Probe pages and compile multimodal samples
        probe_chunk = max(1, self.config.fetch_concurrency)
        for start in range(0, len(deduped_items), probe_chunk):
            if len(phishing_samples) >= desired_phish and len(benign_samples) >= desired_benign:
                break
            chunk = deduped_items[start : start + probe_chunk]
            # Fetch page metadata and DOM structure
            page_metas = await asyncio.gather(
                *(self._fetch_page(item.url, fetch_semaphore) for item in chunk)
            )
            for item, page_meta in zip(chunk, page_metas):
                if len(phishing_samples) >= desired_phish and len(benign_samples) >= desired_benign:
                    break

                # Heuristically classify sample ground truth
                label, confidence, reason = self.labeler.label_candidate(
                    meta=page_meta,
                    target_brand=item.target_brand,
                    search_intent=item.intent,
                )

                # Build full multimodal schema sample
                sample = self.builder.build_sample(
                    meta=page_meta,
                    label=label,
                    target_brand_name=item.target_brand,
                    provenance=DatasetProvenance(
                        sourceType="mock" if self.is_mock else "fetched_metadata",
                        labelSource="unknown" if page_meta.fetch_error else "heuristic",
                        labelConfidence=confidence, labelReason=reason[:256], groupId=page_meta.domain,
                        modalities={"url": "synthetic" if self.is_mock else "observed",
                                    "hid": "synthetic", "dom": "synthetic", "visual": "missing", "logo": "missing"},
                    ),
                )

                if label == 0.5:
                    unknown_samples.append(sample)
                elif label > 0.5:
                    if len(phishing_samples) < desired_phish:
                        phishing_samples.append(sample)
                else:
                    if len(benign_samples) < desired_benign:
                        benign_samples.append(sample)

        # Fill remaining quota from the committed seed snapshot (offline, allowed
        #    in mock mode), then the mock generator as a last resort.
        if (len(phishing_samples) + len(benign_samples)) < target:
            await self._fill_from_seed_snapshot(
                phishing_samples, benign_samples, desired_phish, desired_benign,
                seen_urls, feeds_used, fetch_semaphore,
            )

        # If more samples needed to meet target quota, synthesize extra via mock provider
        if (len(phishing_samples) + len(benign_samples)) < target:
            logger.info("Synthesizing supplemental samples to fulfill target quota...")
            from ..search.providers import MockSearchProvider
            fallback_provider = MockSearchProvider()
            extra_query_count = (target - (len(phishing_samples) + len(benign_samples))) // 2 + 1
            extra_queries = self.query_generator.generate_daily_query_batch(
                phishing_ratio=self.config.phishing_target_ratio,
                total_queries=extra_query_count,
            )
            for eq in extra_queries:
                if len(phishing_samples) + len(benign_samples) >= target:
                    break
                extra_items = await fallback_provider.search(eq)
                for e_item in extra_items:
                    if len(phishing_samples) + len(benign_samples) >= target:
                        break
                    async with fetch_semaphore:
                        p_meta = await self.fetcher.fetch(e_item.url)
                    e_lbl, e_conf, e_reason = self.labeler.label_candidate(p_meta, e_item.target_brand, e_item.intent)
                    e_sample = self.builder.build_sample(
                        p_meta, e_lbl, e_item.target_brand,
                        provenance=DatasetProvenance(
                            sourceType="mock", labelSource="unknown" if p_meta.fetch_error else "heuristic",
                            labelConfidence=e_conf, labelReason=e_reason[:256], groupId=p_meta.domain,
                            modalities={"url": "synthetic", "hid": "synthetic", "dom": "synthetic",
                                        "visual": "missing", "logo": "missing"},
                        ),
                    )
                    if e_lbl == 0.5:
                        unknown_samples.append(e_sample)
                    elif e_lbl > 0.5 and len(phishing_samples) < desired_phish:
                        phishing_samples.append(e_sample)
                    elif e_lbl < 0.5 and len(benign_samples) < desired_benign:
                        benign_samples.append(e_sample)

        # Await Deep Research and append its samples on top of the quota.
        research_payload: Optional[Dict[str, Any]] = None
        research_samples: List[MultimodalDatasetSample] = []
        if research_task is not None:
            try:
                research_result = await research_task
            except Exception as exc:
                logger.warning("Deep Research collection failed: %s", exc)
                research_result = None
            if research_result is not None:
                collected_urls = {s.url.strip().lower() for s in phishing_samples + benign_samples + unknown_samples}
                for finding in research_result.findings:
                    if finding.url.strip().lower() in collected_urls:
                        continue
                    collected_urls.add(finding.url.strip().lower())
                    research_samples.append(self._build_research_sample(finding, feed_index))
                research_payload = {
                    "interactions": research_result.interactions,
                    "discovered_sources": [s.model_dump() for s in research_result.discovered_sources],
                    "url_findings": [f.model_dump() for f in research_result.findings],
                    "reports": research_result.reports,
                }

        all_collected = phishing_samples + benign_samples + unknown_samples + research_samples
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()

        logger.info(
            "Aggregation cycle complete in %.2fs: %d samples (%d phish, %d benign, %d research).",
            duration, len(all_collected), len(phishing_samples), len(benign_samples), len(research_samples),
        )

        return AggregatedDatasetBatch(
            date=date_str,
            samples=all_collected,
            total_samples=len(all_collected),
            phishing_count=len(phishing_samples),
            benign_count=len(benign_samples),
            unknown_count=len(unknown_samples),
            queries_executed=len(queries),
            urls_inspected=len(seen_urls),
            engines_used=sorted(list(engines_used or {"search"})),
            feeds_used=feeds_used,
            research=research_payload,
            duration_seconds=duration,
        )

    def _feed_fetch_limit(self, source_id: str, target: int) -> int:
        """Per-connector record limit so shuffled picks span the whole source."""
        if source_id == "openphish":
            return 10000
        if source_id == "tranco":
            return self.config.tranco_top_n
        if source_id == "phishing_database":
            return max(200, target * 5)
        return max(200, target)

    async def _gather_feed_records(
        self,
        feeds_used: List[str],
        date_str: str,
        target: int,
    ) -> List[FeedRecord]:
        """Fetch all enabled feed connectors concurrently and shuffle records."""
        connectors = self._build_feed_connectors()
        if not connectors:
            return []
        results = await asyncio.gather(
            *(c.fetch(limit=self._feed_fetch_limit(c.source_id, target)) for c in connectors),
            return_exceptions=True,
        )
        records: List[FeedRecord] = []
        for connector, res in zip(connectors, results):
            if isinstance(res, Exception):
                logger.warning("Feed connector '%s' raised: %s", connector.source_id, res)
                continue
            if res:
                feeds_used.append(connector.source_id)
                records.extend(res)
        feed_rng = random.Random(f"{self.config.random_seed}:{date_str}")
        feed_rng.shuffle(records)
        return records

    async def _fetch_page(
        self, url: str, fetch_semaphore: asyncio.Semaphore
    ) -> FetchedPageMetadata:
        async with fetch_semaphore:
            return await self.fetcher.fetch(url)

    async def _build_feed_sample(
        self,
        record: FeedRecord,
        host: str,
        source_type: str,
        fetch_semaphore: asyncio.Semaphore,
    ) -> MultimodalDatasetSample:
        if self.config.fetch_feed_pages:
            async with fetch_semaphore:
                meta = await self.fetcher.fetch(record.url)
            meta.url = record.url
            meta.final_url = record.url
            meta.domain = host
        else:
            meta = FetchedPageMetadata(url=record.url, final_url=record.url, domain=host)

        if record.target_brand:
            brand_enum = BRAND_MAP.get(record.target_brand.lower(), TargetBrandClass.GENERIC_BENIGN)
        elif record.label > 0.5:
            brand_enum = TargetBrandClass.NONE
        else:
            brand_enum = TargetBrandClass.GENERIC_BENIGN

        return self.builder.build_sample(
            meta=meta,
            label=record.label,
            provenance=DatasetProvenance(
                sourceType=source_type,
                labelSource="verified_feed",
                labelConfidence=record.label_confidence,
                labelReason=record.label_reason[:256],
                groupId=host,
                modalities={"url": "observed", "hid": "synthetic", "dom": "synthetic",
                            "visual": "missing", "logo": "missing"},
            ),
            target_brand_enum=brand_enum,
        )

    async def _fill_from_seed_snapshot(
        self,
        phishing_samples: List[MultimodalDatasetSample],
        benign_samples: List[MultimodalDatasetSample],
        desired_phish: int,
        desired_benign: int,
        seen_urls: Set[str],
        feeds_used: List[str],
        fetch_semaphore: asyncio.Semaphore,
    ) -> None:
        seed_feed = SeedSnapshotFeed()
        records = await seed_feed.fetch(limit=500)
        if not records:
            return
        phish_hosts = {host_of(s.url) for s in phishing_samples}
        phish_hosts.discard(None)
        used = False
        for record in records:
            if len(phishing_samples) + len(benign_samples) >= desired_phish + desired_benign:
                break
            norm = record.url.strip().lower()
            if norm in seen_urls:
                continue
            host = host_of(record.url)
            if not host:
                continue
            if record.label > 0.5:
                if len(phishing_samples) >= desired_phish:
                    continue
                phishing_samples.append(await self._build_feed_sample(record, host, "repository_fixture", fetch_semaphore))
                seen_urls.add(norm)
                phish_hosts.add(host)
                used = True
            else:
                if len(benign_samples) >= desired_benign:
                    continue
                if any(host == h or host.endswith("." + h) or h.endswith("." + host) for h in phish_hosts):
                    continue
                benign_samples.append(await self._build_feed_sample(record, host, "repository_fixture", fetch_semaphore))
                seen_urls.add(norm)
                used = True
        if used and seed_feed.source_id not in feeds_used:
            feeds_used.append(seed_feed.source_id)

    def _build_research_sample(
        self, finding: ProcessedUrlFinding, feed_index: Optional[FeedIndex] = None
    ) -> MultimodalDatasetSample:
        host = host_of(finding.url) or "unknown-domain"
        meta = FetchedPageMetadata(url=finding.url, final_url=finding.url, domain=host)

        label = finding.label
        source_type, label_source, confidence = "research_agent", "llm_research", 0.6
        reason = f"Deep Research ({finding.topic_id}): {finding.evidence}"
        match, conflict = corroborate(finding.url, finding.label, feed_index)
        if conflict is not None:
            reason = f"Deep Research ({finding.topic_id}) conflicts with {conflict['source_id']}: {finding.evidence}"
        elif match is not None:
            label_source, label, confidence = "verified_feed", match["label"], match["label_confidence"]
            reason = f"Deep Research finding corroborated by {match['source_id']}"

        if finding.target_brand:
            brand_enum = BRAND_MAP.get(finding.target_brand.lower(), TargetBrandClass.GENERIC_BENIGN)
        elif label > 0.5:
            brand_enum = TargetBrandClass.NONE
        else:
            brand_enum = TargetBrandClass.GENERIC_BENIGN

        return self.builder.build_sample(
            meta=meta,
            label=label,
            provenance=DatasetProvenance(
                sourceType=source_type,
                labelSource=label_source,
                labelConfidence=confidence,
                labelReason=reason[:256],
                groupId=host,
                modalities={"url": "observed", "hid": "synthetic", "dom": "synthetic",
                            "visual": "missing", "logo": "missing"},
            ),
            target_brand_enum=brand_enum,
        )

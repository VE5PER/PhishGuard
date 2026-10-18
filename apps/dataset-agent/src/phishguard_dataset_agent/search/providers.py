"""Search provider implementations for automated web search querying."""

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import logging
import re
from typing import List, Optional
import urllib.parse
import httpx

from phishguard_ml_engine.data.industrial_benchmark_dataset import (
    INDUSTRIAL_PHISHING_RECORDS,
    BRAND_LEGITIMATE_DOMAINS,
)
from .models import SearchQuery, SearchResultItem

logger = logging.getLogger(__name__)


class BaseSearchProvider(ABC):
    """Abstract interface for dataset web search providers."""

    @abstractmethod
    async def search(self, query: SearchQuery) -> List[SearchResultItem]:
        """Execute a search query and return matching items."""
        pass


class MockSearchProvider(BaseSearchProvider):
    """Deterministic mock provider using benchmark records and synthetic lookalikes.

    Ideal for offline testing, local developer environments, and CI/CD pipelines.
    """

    def __init__(self, seed: Optional[int] = None):
        self._counter = 0

    async def search(self, query: SearchQuery) -> List[SearchResultItem]:
        brand = query.target_brand or "Microsoft"
        results: List[SearchResultItem] = []

        if query.intent == "phishing_discovery":
            # Match matching industrial threat records for this brand
            matching_threats = [
                rec for rec in INDUSTRIAL_PHISHING_RECORDS
                if rec.get("brand", "").lower() == brand.lower()
            ]
            for rec in matching_threats[:query.max_results]:
                results.append(
                    SearchResultItem(
                        url=rec["url"],
                        title=f"{brand} Online Security Portal - Urgent Verification",
                        snippet=f"Please verify your {brand} credentials to prevent account suspension.",
                        engine="mock_threat_feed",
                        target_brand=brand,
                        intent=query.intent,
                    )
                )

            # If more results needed, generate plausible lookalike candidates
            tlds = ["xyz", "top", "club", "live", "site"]
            while len(results) < query.max_results:
                self._counter += 1
                tld = tlds[self._counter % len(tlds)]
                fake_domain = f"login-{brand.lower()}-security-auth{self._counter}.{tld}"
                url = f"https://{fake_domain}/signin/v2/checkpoint?ref=search"
                results.append(
                    SearchResultItem(
                        url=url,
                        title=f"{brand} Sign In & Identity Verification",
                        snippet=f"Sign in to your {brand} account to access services and documents.",
                        engine="mock_generator",
                        target_brand=brand,
                        intent=query.intent,
                    )
                )
        else:
            # Benign anchors
            legit_domains = BRAND_LEGITIMATE_DOMAINS.get(brand, [f"{brand.lower()}.com"])
            paths = ["login", "account", "security", "support", "help", "services"]
            idx = 0
            while len(results) < query.max_results:
                dom = legit_domains[idx % len(legit_domains)]
                path = paths[idx % len(paths)]
                results.append(
                    SearchResultItem(
                        url=f"https://www.{dom}/{path}",
                        title=f"Official {brand} Sign In and Security Guidelines",
                        snippet=f"Official security, login portal, and support center for {brand}.",
                        engine="mock_legitimate",
                        target_brand=brand,
                        intent=query.intent,
                    )
                )
                idx += 1

        return results[:query.max_results]


class DuckDuckGoSearchProvider(BaseSearchProvider):
    """DuckDuckGo public HTML search provider with rate-limiting resilience."""

    SEARCH_URL = "https://html.duckduckgo.com/html/"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    def __init__(self, timeout: float = 8.0):
        self.timeout = timeout

    async def search(self, query: SearchQuery) -> List[SearchResultItem]:
        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        data = {"q": query.query_text}

        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                resp = await client.post(self.SEARCH_URL, data=data, headers=headers)
                if resp.status_code != 200:
                    logger.warning("DuckDuckGo returned status %d for query: %s", resp.status_code, query.query_text)
                    return []

                return self._parse_html_results(resp.text, query)
        except Exception as exc:
            logger.warning("DuckDuckGo search error: %s", exc)
            return []

    def _parse_html_results(self, html_content: str, query: SearchQuery) -> List[SearchResultItem]:
        results: List[SearchResultItem] = []
        # Extract DuckDuckGo result links: class="result__url" or <a class="result__snippet" href="...">
        # DuckDuckGo HTML links often come as //duckduckgo.com/l/?uddg=URL
        uddg_matches = re.findall(r'href=["\'](?:https?:)?//duckduckgo\.com/l/\?uddg=([^"\'&]+)', html_content)
        title_matches = re.findall(r'<a class="result__url"[^>]*>([^<]+)</a>', html_content)

        for idx, enc_url in enumerate(uddg_matches[:query.max_results]):
            decoded_url = urllib.parse.unquote(enc_url)
            if not decoded_url.startswith("http"):
                continue
            title = title_matches[idx].strip() if idx < len(title_matches) else f"Result {idx+1}"
            results.append(
                SearchResultItem(
                    url=decoded_url,
                    title=title,
                    snippet="",
                    engine="duckduckgo",
                    target_brand=query.target_brand,
                    intent=query.intent,
                )
            )

        return results


class SerpApiSearchProvider(BaseSearchProvider):
    """Google/Bing SERP provider via SerpAPI."""

    BASE_URL = "https://serpapi.com/search.json"

    def __init__(self, api_key: str, timeout: float = 8.0):
        self.api_key = api_key
        self.timeout = timeout

    async def search(self, query: SearchQuery) -> List[SearchResultItem]:
        params = {
            "q": query.query_text,
            "api_key": self.api_key,
            "engine": "google",
            "num": query.max_results,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(self.BASE_URL, params=params)
                if resp.status_code != 200:
                    logger.warning("SerpAPI error status %d", resp.status_code)
                    return []
                data = resp.json()
                items: List[SearchResultItem] = []
                for org in data.get("organic_results", [])[:query.max_results]:
                    link = org.get("link")
                    if link:
                        items.append(
                            SearchResultItem(
                                url=link,
                                title=org.get("title", ""),
                                snippet=org.get("snippet", ""),
                                engine="serpapi",
                                target_brand=query.target_brand,
                                intent=query.intent,
                            )
                        )
                return items
        except Exception as exc:
            logger.warning("SerpAPI request failure: %s", exc)
            return []


class CompositeSearchProvider(BaseSearchProvider):
    """Auto-routing search provider with robust fallback to offline mock generator."""

    def __init__(
        self,
        provider_name: str = "auto",
        api_key: Optional[str] = None,
        timeout: float = 8.0,
    ):
        self.provider_name = provider_name.lower()
        self.api_key = api_key
        self.timeout = timeout
        self.mock = MockSearchProvider()
        self.ddg = DuckDuckGoSearchProvider(timeout=timeout)
        self.serp = SerpApiSearchProvider(api_key=api_key, timeout=timeout) if api_key else None

    async def search(self, query: SearchQuery) -> List[SearchResultItem]:
        if self.provider_name == "mock":
            return await self.mock.search(query)

        if self.provider_name == "serpapi" and self.serp:
            results = await self.serp.search(query)
            if results:
                return results

        if self.provider_name in ("auto", "duckduckgo"):
            if self.serp:
                results = await self.serp.search(query)
                if results:
                    return results

            results = await self.ddg.search(query)
            if results:
                return results

        # Fallback to mock provider to ensure resilience and zero pipeline interruption
        logger.info("Using mock fallback search provider for query: %s", query.query_text)
        return await self.mock.search(query)

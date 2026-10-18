"""Public feed connectors for verified phishing and benign URL sources."""

from abc import ABC, abstractmethod
import contextlib
import csv
import io
import logging
from pathlib import Path
from typing import AsyncIterator, List, Optional
import urllib.parse
import zipfile

import httpx

from ..collector.sample_builder import BRAND_MAP
from .models import FeedRecord

logger = logging.getLogger(__name__)

SEEDS_DIR = Path(__file__).resolve().parent / "seeds"

USER_AGENT = "PhishGuardCollector/1.0 (dataset research)"


def host_of(url: str) -> Optional[str]:
    """Return the lowercased hostname of a URL, or None when unparseable."""
    try:
        host = urllib.parse.urlparse(url).hostname
    except ValueError:
        return None
    if not host:
        return None
    return host.lower().rstrip(".")


def infer_target_brand(url: str) -> Optional[str]:
    """Match a URL's host/path against known brand tokens.

    Returns the canonical TargetBrandClass value for the first matching
    BRAND_MAP key (spaces removed), or None when no brand token appears.
    """
    try:
        parsed = urllib.parse.urlparse(url)
        haystack = ((parsed.hostname or "") + parsed.path).lower()
    except ValueError:
        return None
    for key, brand_enum in BRAND_MAP.items():
        if key.replace(" ", "") in haystack:
            return brand_enum.value
    return None


def refang_url(url: str) -> str:
    """Restore a defanged URL (hxxp, [.], (.), [dot]) to clickable form."""
    u = url.strip().strip("[]()<>\"'")
    lowered = u.lower()
    for defanged, real in (("hxxps://", "https://"), ("hxxp://", "http://")):
        if lowered.startswith(defanged):
            u = real + u[len(defanged):]
            break
    # Refang the authority component only; path/query stay untouched.
    if "://" in u:
        scheme, rest = u.split("://", 1)
        prefix = scheme + "://"
    else:
        rest = u
        prefix = ""
    authority, sep, tail = rest.partition("/")
    for token in ("[.]", "(.)", "[dot]", "(dot)"):
        authority = authority.replace(token, ".")
    return prefix + authority + (sep + tail if sep else "")


def normalize_candidate_url(url: str) -> Optional[str]:
    """Refang and normalize a candidate URL.

    Bare domains become https URLs; returns None unless the result is
    http(s) with a parseable hostname.
    """
    u = refang_url(url)
    if "://" not in u:
        u = "https://" + u
    try:
        parsed = urllib.parse.urlparse(u)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or "." not in host:
        return None
    return urllib.parse.urlunparse(
        (parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.params, parsed.query, parsed.fragment)
    )


class BaseFeedConnector(ABC):
    """Interface for public feed connectors. Never raises from fetch()."""

    source_id: str = ""

    def __init__(self, client: Optional[httpx.AsyncClient] = None, timeout: float = 30.0):
        self._client = client
        self.timeout = timeout

    async def fetch(self, limit: int) -> List[FeedRecord]:
        """Fetch up to `limit` records; returns [] on any failure."""
        try:
            return await self._fetch(limit)
        except Exception as exc:
            logger.warning("Feed connector '%s' failed: %s", self.source_id, exc)
            return []

    @abstractmethod
    async def _fetch(self, limit: int) -> List[FeedRecord]:
        """Connector-specific fetch implementation."""

    @contextlib.asynccontextmanager
    async def _http(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._client is not None:
            yield self._client
        else:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                headers={"User-Agent": USER_AGENT},
            ) as client:
                yield client


class OpenPhishFeed(BaseFeedConnector):
    """OpenPhish community feed: verified phishing URLs, plain text."""

    source_id = "openphish"
    FEED_URL = "https://openphish.com/feed.txt"

    async def _fetch(self, limit: int) -> List[FeedRecord]:
        records: List[FeedRecord] = []
        seen_hosts = set()
        async with self._http() as client:
            resp = await client.get(self.FEED_URL)
            resp.raise_for_status()
            for line in resp.text.splitlines():
                line = line.strip()
                if not line.startswith(("http://", "https://")):
                    continue
                host = host_of(line)
                if not host or host in seen_hosts:
                    continue
                seen_hosts.add(host)
                records.append(
                    FeedRecord(
                        url=line,
                        label=1.0,
                        source_id=self.source_id,
                        label_confidence=0.97,
                        label_reason="OpenPhish community feed listing",
                        target_brand=infer_target_brand(line),
                    )
                )
                if len(records) >= limit:
                    break
        return records


class TrancoTopSitesFeed(BaseFeedConnector):
    """Tranco daily top-sites list: high-confidence benign domain anchors."""

    source_id = "tranco"
    LATEST_API = "https://tranco-list.eu/api/lists/date/latest"
    ZIP_FALLBACK_URL = "https://tranco-list.eu/top-1m.csv.zip"

    def __init__(
        self,
        client: Optional[httpx.AsyncClient] = None,
        timeout: float = 30.0,
        top_n: int = 10000,
    ):
        super().__init__(client=client, timeout=timeout)
        self.top_n = top_n

    async def _fetch(self, limit: int) -> List[FeedRecord]:
        async with self._http() as client:
            meta_resp = await client.get(self.LATEST_API)
            meta_resp.raise_for_status()
            list_id = meta_resp.json()["list_id"]
            pairs = await self._download_ranked_domains(client, list_id)
        records = [
            FeedRecord(
                url=f"https://{domain}/",
                label=0.0,
                source_id=self.source_id,
                label_confidence=0.95,
                label_reason=f"Tranco top-sites rank {rank} (list {list_id})",
                target_brand=None,
            )
            for rank, domain in pairs[:limit]
        ]
        return records

    async def _download_ranked_domains(self, client: httpx.AsyncClient, list_id: str) -> List[tuple]:
        url = f"https://tranco-list.eu/download/{list_id}/{self.top_n}"
        resp = await client.get(url)
        if resp.status_code == 200 and "csv" in resp.headers.get("content-type", "").lower():
            return self._parse_csv_pairs(resp.text)
        logger.info("Tranco download endpoint returned no CSV for %s; falling back to top-1m zip", url)
        zip_resp = await client.get(self.ZIP_FALLBACK_URL)
        zip_resp.raise_for_status()
        return self._parse_zip_pairs(zip_resp.content)[: self.top_n]

    @staticmethod
    def _parse_csv_pairs(text: str) -> List[tuple]:
        pairs = []
        for row in csv.reader(io.StringIO(text)):
            if len(row) < 2 or not row[0].strip().isdigit():
                continue
            pairs.append((int(row[0].strip()), row[1].strip().lower()))
        pairs.sort(key=lambda p: p[0])
        return pairs

    def _parse_zip_pairs(self, content: bytes) -> List[tuple]:
        pairs: List[tuple] = []
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            for name in zf.namelist():
                if not name.lower().endswith(".csv"):
                    continue
                with zf.open(name) as f:
                    text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
                    pairs.extend(self._parse_csv_pairs(text.read()))
                break
        return pairs


class PhishingDatabaseFeed(BaseFeedConnector):
    """Phishing.Database cumulative feed; community trust, withheld from training."""

    source_id = "phishing_database"
    FEED_URL = "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-links-ACTIVE.txt"

    async def _fetch(self, limit: int) -> List[FeedRecord]:
        records: List[FeedRecord] = []
        seen_hosts = set()
        async with self._http() as client:
            async with client.stream("GET", self.FEED_URL) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith(("http://", "https://")):
                        continue
                    host = host_of(line)
                    if not host or host in seen_hosts:
                        continue
                    seen_hosts.add(host)
                    records.append(
                        FeedRecord(
                            url=line,
                            label=1.0,
                            source_id=self.source_id,
                            label_confidence=0.90,
                            label_reason="Phishing.Database community feed (cumulative, unverified)",
                            target_brand=infer_target_brand(line),
                        )
                    )
                    if len(records) >= limit:
                        break
        return records


class SeedSnapshotFeed(BaseFeedConnector):
    """Committed seed snapshot: defanged OpenPhish + Tranco rows in the repo."""

    source_id = "seed_snapshot"

    def __init__(self, csv_path: Optional[Path] = None):
        super().__init__(client=None)
        self.csv_path = Path(csv_path) if csv_path else SEEDS_DIR / "seed_urls.csv"

    async def _fetch(self, limit: int) -> List[FeedRecord]:
        records: List[FeedRecord] = []
        with open(self.csv_path, "r", encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                url = normalize_candidate_url(row["url"])
                if not url:
                    continue
                records.append(
                    FeedRecord(
                        url=url,
                        label=float(row["label"]),
                        source_id=row["source_id"],
                        label_confidence=float(row["label_confidence"]),
                        label_reason=f"Committed seed snapshot {row.get('snapshot_date', '')} ({row['source_id']})",
                        target_brand=row.get("target_brand") or None,
                    )
                )
                if len(records) >= limit:
                    break
        return records

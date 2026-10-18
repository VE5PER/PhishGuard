"""Deterministic feed index used to corroborate research findings (never LLM-assigned)."""

import urllib.parse
from typing import Any, Dict, Iterable, Optional

from ..sources.feeds import host_of, normalize_candidate_url
from ..sources.models import FeedRecord

FeedIndex = Dict[str, Dict[str, Dict[str, Any]]]


def url_match_key(url: str) -> Optional[str]:
    """Normalized exact-match key: lowercase scheme/host, no trailing slash, query kept, no fragment."""
    normalized = normalize_candidate_url(url)
    if not normalized:
        return None
    parsed = urllib.parse.urlparse(normalized)
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.params, parsed.query, ""))


def build_feed_index(records: Iterable[FeedRecord]) -> FeedIndex:
    index: FeedIndex = {"phishing_urls": {}, "phishing_hosts": {}, "benign_hosts": {}}
    for record in records:
        host = host_of(record.url)
        if not host:
            continue
        info = {
            "source_id": record.source_id,
            "label": record.label,
            "label_confidence": record.label_confidence,
        }
        if record.label > 0.5:
            key = url_match_key(record.url)
            if key:
                index["phishing_urls"].setdefault(key, info)
            index["phishing_hosts"].setdefault(host, info)
        elif record.label < 0.5:
            index["benign_hosts"].setdefault(host, info)
    return index


def corroborate(url: str, label: float, index: Optional[FeedIndex]) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Return (matching feed info, conflicting feed info) for a research finding."""
    if not index:
        return None, None
    host = host_of(url)
    if label > 0.5:
        key = url_match_key(url)
        match = index["phishing_urls"].get(key) if key else None
        conflict = index["benign_hosts"].get(host) if host else None
    else:
        match = index["benign_hosts"].get(host) if host else None
        conflict = index["phishing_hosts"].get(host) if host else None
    return match, conflict

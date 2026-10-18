"""Asynchronous web page fetcher and DOM inspector for dataset aggregation."""

import logging
import re
from typing import Dict, Optional
import urllib.parse
import httpx

from .models import FetchedPageMetadata

logger = logging.getLogger(__name__)


class PageFetcher:
    """Safely inspects web pages over HTTP/HTTPS with size and timeout guards."""

    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 PhishGuardCollector/1.0"

    def __init__(self, timeout: float = 8.0, max_bytes: int = 512 * 1024, mock_mode: bool = False):
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.mock_mode = mock_mode

    @staticmethod
    def extract_domain(url: str) -> str:
        """Extract clean hostname/domain from URL."""
        try:
            parsed = urllib.parse.urlparse(url)
            netloc = (parsed.hostname or "").strip().lower().rstrip(".")
        except ValueError:
            return "unknown-domain"
        try:
            netloc = netloc.encode("idna").decode("ascii")
        except UnicodeError:
            netloc = ""
        return netloc or "unknown-domain"

    async def fetch(self, url: str) -> FetchedPageMetadata:
        """Fetch and extract page features from URL."""
        domain = self.extract_domain(url)

        if self.mock_mode:
            has_login = "login" in url.lower() or "signin" in url.lower() or "checkpoint" in url.lower()
            return FetchedPageMetadata(
                url=url,
                final_url=url,
                domain=domain,
                status_code=200,
                title=f"Authentication & Account Portal for {domain}",
                forms_count=1 if has_login else 0,
                password_inputs_count=1 if has_login else 0,
                has_login_form=has_login,
                ssl_valid=url.startswith("https"),
                headers={"server": "nginx", "content-type": "text/html; charset=UTF-8"},
                text_snippet="Secure account verification portal and document sign in session.",
                fetch_error=None,
            )

        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                verify=False,  # Allow inspecting untrusted/self-signed phishing certificates
            ) as client:
                resp = await client.get(url, headers=headers)
                final_url = str(resp.url)
                final_domain = self.extract_domain(final_url)

                content_type = resp.headers.get("content-type", "")
                if "html" not in content_type and resp.text.strip():
                    # Still inspect text if possible
                    pass

                # Inspect HTML content truncated to max_bytes
                raw_text = resp.text[: self.max_bytes]
                title = self._extract_title(raw_text)
                forms_count = len(re.findall(r"<form\b", raw_text, re.IGNORECASE))
                pwd_inputs = len(re.findall(r'<input[^>]+type=["\']password["\']', raw_text, re.IGNORECASE))
                has_login = pwd_inputs > 0 or bool(re.search(r"\b(login|signin|sign-in|authenticate)\b", raw_text, re.IGNORECASE))

                extracted_headers: Dict[str, str] = {
                    k.lower(): v for k, v in resp.headers.items()
                    if k.lower() in ("server", "content-type", "x-powered-by", "location")
                }

                snippet = re.sub(r"<[^>]+>", " ", raw_text[:1000]).strip()
                snippet = " ".join(snippet.split())[:300]

                return FetchedPageMetadata(
                    url=url,
                    final_url=final_url,
                    domain=final_domain,
                    status_code=resp.status_code,
                    title=title,
                    forms_count=forms_count,
                    password_inputs_count=pwd_inputs,
                    has_login_form=has_login,
                    ssl_valid=url.startswith("https"),
                    headers=extracted_headers,
                    text_snippet=snippet,
                    fetch_error=None,
                )

        except Exception as exc:
            logger.debug("Fetch failed for %s: %s", url, exc)
            # Create graceful synthetic fallback metadata so processing continues
            return FetchedPageMetadata(
                url=url,
                final_url=url,
                domain=domain,
                status_code=0,
                title="",
                forms_count=0,
                password_inputs_count=0,
                has_login_form=False,
                ssl_valid=url.startswith("https"),
                headers={},
                text_snippet="",
                fetch_error=str(exc),
            )

    def _extract_title(self, html: str) -> str:
        match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        if match:
            clean = " ".join(match.group(1).split())
            return clean[:200]
        return ""

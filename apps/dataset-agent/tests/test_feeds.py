"""Tests for public feed connectors using httpx.MockTransport."""

import asyncio
import io
import zipfile

import httpx
import pytest

from phishguard_dataset_agent.sources.feeds import (
    OpenPhishFeed,
    TrancoTopSitesFeed,
    PhishingDatabaseFeed,
    infer_target_brand,
)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_openphish_parsing():
    feed_text = (
        "https://login-microsoft-verify.evil-example.com/signin\n"
        "http://secure-paypal-check.phish-host.net/\n"
        "https://login-microsoft-verify.evil-example.com/other-path\n"  # dup host
        "not-a-url\n"
        "ftp://ignore.me/file\n"
        "https://third-bad.example.org/x\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == OpenPhishFeed.FEED_URL
        return httpx.Response(200, text=feed_text)

    async def _run():
        return await OpenPhishFeed(client=_client(handler)).fetch(limit=10)

    records = asyncio.run(_run())
    assert len(records) == 3  # one per unique hostname
    assert all(r.label == 1.0 for r in records)
    assert all(r.source_id == "openphish" for r in records)
    assert all(r.label_confidence == 0.97 for r in records)
    assert records[0].target_brand == "Microsoft"
    assert records[1].target_brand == "PayPal"
    assert records[2].target_brand is None


def test_openphish_http_error_returns_empty():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async def _run():
        return await OpenPhishFeed(client=_client(handler)).fetch(limit=10)

    assert asyncio.run(_run()) == []


def test_tranco_parsing():
    latest = {"list_id": "TEST1", "download": "https://tranco-list.eu/download/TEST1/1000"}
    csv_body = "1,google.com\n2,cloudflare.com\n3,facebook.com\n"

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("api/lists/date/latest"):
            return httpx.Response(200, json=latest)
        if url == "https://tranco-list.eu/download/TEST1/3":
            return httpx.Response(200, text=csv_body, headers={"content-type": "text/csv"})
        return httpx.Response(404)

    async def _run():
        return await TrancoTopSitesFeed(client=_client(handler), top_n=3).fetch(limit=10)

    records = asyncio.run(_run())
    assert len(records) == 3
    assert records[0].url == "https://google.com/"
    assert all(r.label == 0.0 for r in records)
    assert all(r.label_confidence == 0.95 for r in records)
    assert "TEST1" in records[0].label_reason
    assert "rank 1" in records[0].label_reason


def test_tranco_zip_fallback():
    latest = {"list_id": "TEST2"}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("top-1m.csv", "1,aaa.com\n2,bbb.com\n")

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("api/lists/date/latest"):
            return httpx.Response(200, json=latest)
        if "/download/" in url:
            return httpx.Response(404)
        if url == TrancoTopSitesFeed.ZIP_FALLBACK_URL:
            return httpx.Response(200, content=buf.getvalue(), headers={"content-type": "application/zip"})
        return httpx.Response(404)

    async def _run():
        return await TrancoTopSitesFeed(client=_client(handler), top_n=1000).fetch(limit=10)

    records = asyncio.run(_run())
    assert [r.url for r in records] == ["https://aaa.com/", "https://bbb.com/"]


def test_phishing_database_streams_and_dedupes():
    body = "http://bad-one.example/x\nhttp://bad-one.example/y\nhttps://bad-two.example/\nsome junk\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body)

    async def _run():
        return await PhishingDatabaseFeed(client=_client(handler)).fetch(limit=10)

    records = asyncio.run(_run())
    assert len(records) == 2
    assert all(r.label_confidence == 0.90 for r in records)


def test_infer_target_brand():
    assert infer_target_brand("https://login-microsoft-secure.xyz/") == "Microsoft"
    assert infer_target_brand("https://x.example.com/bankofamerica/signin") == "Bank of America"
    assert infer_target_brand("https://wellsfargo-alert.top/") == "Wells Fargo"
    assert infer_target_brand("https://unrelated-domain.org/page") is None
    assert infer_target_brand("not a url") is None

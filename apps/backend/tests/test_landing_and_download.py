"""Unit tests for FastAPI landing page static serving and extension distribution."""

import pytest
from starlette.testclient import TestClient
from phishguard_backend import main as backend_main
from phishguard_backend.main import app, STATIC_DIR, DOWNLOADS_DIR


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_extension_latest_metadata(client: TestClient):
    """Ensure GET /v1/extension/latest returns valid version, extension ID, and SHA-256 digest."""
    res = client.get("/v1/extension/latest")
    assert res.status_code == 200
    data = res.json()
    assert data["version"] in ["0.1.0", "0.1.1", "0.2.0", "0.3.0"] or len(data["version"].split(".")) == 3
    assert "sha256" in data
    assert len(data["sha256"]) == 64
    assert data["filename"] == "phishguard-extension.zip"
    assert data["download_url"] == "/download/extension"
    if "extension_id" in data:
        assert len(data["extension_id"]) == 32


def test_extension_zip_download_endpoint(client: TestClient):
    """Ensure GET /download, /download/extension, and /download/phishguard-extension.zip stream zip."""
    for path in ["/download", "/download/extension", "/download/phishguard-extension.zip"]:
        res = client.get(path)
        assert res.status_code == 200
        assert "application/zip" in res.headers["content-type"]
        assert "phishguard-extension" in res.headers["content-disposition"]
        assert res.headers["content-disposition"].endswith('.zip"')
        assert "X-Extension-SHA256" in res.headers
        assert len(res.headers["X-Extension-SHA256"]) == 64
        # Verify body contains valid zip magic header PK\x03\x04
        assert res.content[:4] == b"PK\x03\x04"


def test_extension_crx_download_endpoint(client: TestClient):
    """Ensure GET /download/crx and /download/phishguard-extension.crx stream signed CRX."""
    crx_file = DOWNLOADS_DIR / "phishguard-extension.crx"
    if not crx_file.exists():
        pytest.skip("phishguard-extension.crx not present on disk")

    for path in ["/download/crx", "/download/phishguard-extension.crx"]:
        res = client.get(path)
        assert res.status_code == 200
        assert "application/x-chrome-extension" in res.headers["content-type"]
        assert "phishguard-extension" in res.headers["content-disposition"]
        assert res.headers["content-disposition"].endswith('.crx"')
        assert "X-Extension-ID" in res.headers
        assert len(res.headers["X-Extension-ID"]) == 32
        assert "X-Extension-SHA256" in res.headers
        # Verify body contains valid CRX3 magic header Cr24 (0x43 0x72 0x32 0x34)
        assert res.content[:4] == b"Cr24"


def test_extension_updates_xml_endpoint(client: TestClient):
    """Ensure GET /updates.xml and /download/updates.xml stream valid autoupdate manifest."""
    updates_file = DOWNLOADS_DIR / "updates.xml"
    if not updates_file.exists():
        pytest.skip("updates.xml not present on disk")

    for path in ["/updates.xml", "/download/updates.xml"]:
        res = client.get(path)
        assert res.status_code == 200
        assert "application/xml" in res.headers["content-type"]
        assert b"<gupdate" in res.content
        assert b"protocol='2.0'" in res.content
        assert b"<updatecheck" in res.content


def test_landing_page_static_serving(client: TestClient):
    """Ensure GET / serves landing page index.html."""
    index_file = STATIC_DIR / "index.html"
    created_dummy = False
    if not index_file.exists():
        index_file.write_text("<!DOCTYPE html><html><body>PhishGuard Landing Test</body></html>", encoding="utf-8")
        created_dummy = True

    try:
        res = client.get("/")
        assert res.status_code == 200
        assert "text/html" in res.headers["content-type"]
        assert "PhishGuard" in res.text
    finally:
        if created_dummy and index_file.exists():
            index_file.unlink()


def test_health_still_works(client: TestClient):
    """Ensure /health endpoint is not shadowed by static route."""
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "healthy"


def test_extension_versions_endpoints(client: TestClient):
    """Ensure /v1/extension/versions and /download/versions return discoverable release versions."""
    for path in ["/v1/extension/versions", "/download/versions"]:
        res = client.get(path)
        assert res.status_code == 200
        data = res.json()
        assert "versions" in data
        assert isinstance(data["versions"], list)
        assert len(data["versions"]) >= 1
        first = data["versions"][0]
        assert "version" in first
        assert "is_latest" in first
        assert "crx_download_url" in first
        assert "zip_download_url" in first


def test_specific_version_download_endpoints(client: TestClient):
    """Ensure /download/version/{version}/zip and /download/version/{version}/crx download targeted versions."""
    res_zip = client.get("/download/version/0.1.0/zip")
    assert res_zip.status_code == 200
    assert "application/zip" in res_zip.headers["content-type"]
    assert "0.1.0" in res_zip.headers.get("X-Extension-Version", "")

    res_crx = client.get("/download/version/0.1.0/crx")
    assert res_crx.status_code == 200
    assert "application/x-chrome-extension" in res_crx.headers["content-type"]
    assert "0.1.0" in res_crx.headers.get("X-Extension-Version", "")

    res_latest_zip = client.get("/download/version/0.2.0/zip")
    assert res_latest_zip.status_code == 200
    assert "0.2.0" in res_latest_zip.headers.get("X-Extension-Version", "")


def test_versioned_crx_alias_and_webstore_zip(client: TestClient, tmp_path, monkeypatch):
    """Ensure the absolute updates.xml codebase path and the Web Store zip are served from disk."""
    (tmp_path / "phishguard-extension-v9.9.9.crx").write_bytes(b"Cr24" + b"\x00" * 16)
    (tmp_path / "phishguard-extension-webstore.zip").write_bytes(b"PK\x03\x04" + b"\x00" * 16)
    monkeypatch.setattr(backend_main, "DOWNLOADS_DIR", tmp_path)

    res = client.get("/download/phishguard-extension-v9.9.9.crx")
    assert res.status_code == 200
    assert "application/x-chrome-extension" in res.headers["content-type"]
    assert res.headers["content-disposition"].endswith('.crx"')
    assert res.content[:4] == b"Cr24"

    head = client.head("/download/phishguard-extension-v9.9.9.crx")
    assert head.status_code == 200

    res = client.get("/download/phishguard-extension-webstore.zip")
    assert res.status_code == 200
    assert "application/zip" in res.headers["content-type"]
    assert "phishguard-extension-webstore.zip" in res.headers["content-disposition"]
    assert res.content[:4] == b"PK\x03\x04"

    assert client.head("/download/phishguard-extension-webstore.zip").status_code == 200


def test_webstore_zip_missing_returns_404(client: TestClient, tmp_path, monkeypatch):
    async def no_artifact(_key):
        return None

    monkeypatch.setattr(backend_main, "DOWNLOADS_DIR", tmp_path)
    monkeypatch.setattr(backend_main.artifact_storage, "get_artifact_meta", no_artifact)
    res = client.get("/download/phishguard-extension-webstore.zip")
    assert res.status_code == 404


def test_sample_pages_serving(client: TestClient):
    """Ensure /sample1, /sample2, and /sample3 sample testbench pages are served with HTTP 200."""
    for path in ("/sample1", "/sample2", "/sample3"):
        res = client.get(path)
        assert res.status_code == 200, f"Expected 200 for {path}, got {res.status_code}"
        assert "text/html" in res.headers["content-type"]
        assert "PhishGuard" in res.text


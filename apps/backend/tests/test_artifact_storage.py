"""Tests for RustFS Artifact Storage Service and distribution endpoints."""

import hashlib
import json
import pytest
import httpx
from starlette.testclient import TestClient
from pathlib import Path

from phishguard_backend.main import app
from phishguard_backend.services.storage import (
    RustFSArtifactStorageService,
    _sign_s3_v4_headers,
)


def test_sign_s3_v4_headers():
    """Verify AWS SigV4 header computation produces standard authorization headers."""
    headers = {"Content-Type": "application/octet-stream"}
    signed = _sign_s3_v4_headers(
        method="GET",
        url="http://rustfs:9000/phishguard-artifacts/model.onnx",
        headers=headers,
        payload=b"",
        access_key="test_access",
        secret_key="test_secret",
        region="us-east-1",
        service="s3",
    )
    assert "Authorization" in signed
    assert signed["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=test_access/")
    assert "SignedHeaders=" in signed["Authorization"]
    assert "Signature=" in signed["Authorization"]
    assert "x-amz-date" in signed
    assert "x-amz-content-sha256" in signed


@pytest.mark.anyio
async def test_rustfs_service_init_defaults():
    """Verify RustFS storage service defaults to http://rustfs:9000/."""
    storage = RustFSArtifactStorageService()
    assert storage.endpoint_url == "http://rustfs:9000"
    assert storage.bucket == "phishguard-artifacts"
    assert storage._get_object_url("test.onnx") == "http://rustfs:9000/phishguard-artifacts/test.onnx"
    assert storage._get_bucket_url() == "http://rustfs:9000/phishguard-artifacts"


@pytest.mark.anyio
async def test_rustfs_service_health_check_mock(monkeypatch):
    """Test health probe against mocked RustFS responses."""
    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    # Mock success
    async def mock_get(self, url, **kwargs):
        return httpx.Response(200, json={"status": "healthy"})

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)
    assert await storage.is_healthy() is True

    # Mock failure
    async def mock_get_fail(self, url, **kwargs):
        raise httpx.ConnectError("Connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get_fail)
    assert await storage.is_healthy() is False


@pytest.mark.anyio
async def test_rustfs_upload_and_get_artifact_mock(monkeypatch):
    """Test artifact upload and download methods with mocked httpx transport."""
    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    mock_db = {}

    async def mock_put(self, url, **kwargs):
        content = kwargs.get("content", b"")
        mock_db[url] = {
            "content": content,
            "headers": {"content-type": kwargs.get("headers", {}).get("Content-Type", "application/octet-stream")},
        }
        return httpx.Response(200)

    async def mock_get(self, url, **kwargs):
        if url in mock_db:
            return httpx.Response(
                200,
                content=mock_db[url]["content"],
                headers=mock_db[url]["headers"],
            )
        return httpx.Response(404)

    async def mock_head(self, url, **kwargs):
        if url in mock_db:
            return httpx.Response(200, headers=mock_db[url]["headers"])
        return httpx.Response(404)

    monkeypatch.setattr(httpx.AsyncClient, "put", mock_put)
    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)
    monkeypatch.setattr(httpx.AsyncClient, "head", mock_head)

    # Upload
    ok = await storage.upload_artifact("test/model.onnx", b"MOCK_ONNX_BYTES", content_type="application/octet-stream")
    assert ok is True

    # Check existence
    assert await storage.has_artifact("test/model.onnx") is True
    assert await storage.has_artifact("nonexistent.onnx") is False

    # Retrieve
    res = await storage.get_artifact("test/model.onnx")
    assert res is not None
    data, c_type, _ = res
    assert data == b"MOCK_ONNX_BYTES"
    assert c_type == "application/octet-stream"


@pytest.mark.anyio
async def test_rustfs_sync_local_artifacts_mock(monkeypatch, tmp_path):
    """Test local artifact scanner syncing files to RustFS."""
    downloads_dir = tmp_path / "downloads"
    downloads_dir.mkdir()
    (downloads_dir / "phishguard-extension.zip").write_bytes(b"ZIP_BYTES")
    (downloads_dir / "updates.xml").write_text("<xml/>")

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "student_model.onnx").write_bytes(b"ONNX_BYTES")

    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    uploaded_keys = []

    async def mock_upload_file(self, key, file_path, **kwargs):
        uploaded_keys.append(key)
        return True

    async def mock_ensure_bucket(self):
        return True

    async def mock_get_artifact_meta(self, key):
        return None

    monkeypatch.setattr(RustFSArtifactStorageService, "upload_file", mock_upload_file)
    monkeypatch.setattr(RustFSArtifactStorageService, "ensure_bucket", mock_ensure_bucket)
    monkeypatch.setattr(RustFSArtifactStorageService, "get_artifact_meta", mock_get_artifact_meta)

    res = await storage.sync_local_artifacts(downloads_dir, models_dir)
    assert res["total"] >= 2
    assert "extension/phishguard-extension.zip" in uploaded_keys
    assert "models/student_model.onnx" in uploaded_keys


@pytest.mark.anyio
async def test_rustfs_sync_skips_unchanged_artifacts(monkeypatch, tmp_path):
    """Verify sync skips re-uploading artifacts whose remote sha256 metadata already matches."""
    downloads_dir = tmp_path / "downloads"
    downloads_dir.mkdir()
    zip_bytes = b"ZIP_BYTES_UNCHANGED"
    (downloads_dir / "phishguard-extension.zip").write_bytes(zip_bytes)
    zip_sha = hashlib.sha256(zip_bytes).hexdigest()

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "student_model.onnx").write_bytes(b"ONNX_BYTES")

    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    uploaded_keys = []

    async def mock_upload_file(self, key, file_path, **kwargs):
        uploaded_keys.append(key)
        return True

    async def mock_ensure_bucket(self):
        return True

    async def mock_get_artifact_meta(self, key):
        if key in ("extension/phishguard-extension.zip", "phishguard-extension.zip"):
            return {"x-amz-meta-sha256": zip_sha}
        return None

    monkeypatch.setattr(RustFSArtifactStorageService, "upload_file", mock_upload_file)
    monkeypatch.setattr(RustFSArtifactStorageService, "ensure_bucket", mock_ensure_bucket)
    monkeypatch.setattr(RustFSArtifactStorageService, "get_artifact_meta", mock_get_artifact_meta)

    res = await storage.sync_local_artifacts(downloads_dir, models_dir)
    assert "extension/phishguard-extension.zip" not in uploaded_keys
    assert "phishguard-extension.zip" not in uploaded_keys
    assert "models/student_model.onnx" in uploaded_keys
    assert "extension/phishguard-extension.zip" in res["skipped"]
    assert "phishguard-extension.zip" in res["skipped"]
    assert res["total"] >= 2


@pytest.mark.anyio
async def test_rustfs_sync_uses_per_file_sha256_for_versioned_zips(monkeypatch, tmp_path):
    """Verify a versioned zip's sha256 metadata comes from its own bytes, not extension-meta.json."""
    downloads_dir = tmp_path / "downloads"
    downloads_dir.mkdir()
    zip_bytes = b"OLDER_VERSION_ZIP_BYTES"
    (downloads_dir / "phishguard-extension-v0.9.0.zip").write_bytes(zip_bytes)
    own_sha = hashlib.sha256(zip_bytes).hexdigest()
    latest_sha = hashlib.sha256(b"LATEST_BUILD_ZIP_BYTES").hexdigest()
    (downloads_dir / "extension-meta.json").write_text(
        json.dumps({"sha256": latest_sha, "crx_sha256": latest_sha})
    )

    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    captured_metadata = {}

    async def mock_upload_file(self, key, file_path, **kwargs):
        captured_metadata[key] = kwargs.get("metadata", {})
        return True

    async def mock_ensure_bucket(self):
        return True

    async def mock_get_artifact_meta(self, key):
        return None

    monkeypatch.setattr(RustFSArtifactStorageService, "upload_file", mock_upload_file)
    monkeypatch.setattr(RustFSArtifactStorageService, "ensure_bucket", mock_ensure_bucket)
    monkeypatch.setattr(RustFSArtifactStorageService, "get_artifact_meta", mock_get_artifact_meta)

    await storage.sync_local_artifacts(downloads_dir, None)

    zip_meta = captured_metadata["extension/phishguard-extension-v0.9.0.zip"]
    assert zip_meta["sha256"] == own_sha
    assert zip_meta["sha256"] != latest_sha
    mirror_meta = captured_metadata["phishguard-extension-v0.9.0.zip"]
    assert mirror_meta["sha256"] == own_sha


def test_health_endpoint_does_not_leak_internals():
    """Verify /health returns healthy status without leaking internal storage backend, endpoints, buckets, service name, or version."""
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "capabilities" in data
    assert "storage" not in data
    assert "service" not in data
    assert "version" not in data
    assert "backend" not in data
    assert "endpoint" not in data
    assert "bucket" not in data



def test_v1_artifacts_endpoint_missing_returns_404():
    """Verify /v1/artifacts/{path} returns 404 when artifact is not in storage."""
    client = TestClient(app)
    response = client.get("/v1/artifacts/nonexistent/artifact.onnx")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_get_latest_extension_build_from_bucket(monkeypatch):
    """Verify get_latest_extension_build parses latest.json from the bucket."""
    storage = RustFSArtifactStorageService(endpoint_url="http://rustfs:9000")

    mock_build_json = b'{"version": "1.2.3", "sha256": "abcdef", "filename": "phishguard-extension-v1.2.3.zip"}'

    async def mock_get_artifact(key: str):
        if key in ("extension/latest.json", "latest.json"):
            return mock_build_json, "application/json", {}
        return None

    monkeypatch.setattr(storage, "get_artifact", mock_get_artifact)
    build_info = await storage.get_latest_extension_build()
    assert build_info is not None
    assert build_info["version"] == "1.2.3"
    assert build_info["filename"] == "phishguard-extension-v1.2.3.zip"


def test_download_version_latest_endpoint():
    """Verify GET /download/version/latest returns latest build information."""
    client = TestClient(app)
    res = client.get("/download/version/latest")
    assert res.status_code == 200
    data = res.json()
    assert "version" in data
    assert "sha256" in data


def test_download_button_queries_and_downloads_latest_build(monkeypatch):
    """Verify clicking download button (/download/extension) queries latest build and includes version header."""
    manifest = json.loads((Path(__file__).resolve().parents[2] / "extension" / "manifest.json").read_text(encoding="utf-8"))
    from phishguard_backend.main import artifact_storage
    async def mock_latest():
        return {"version": manifest["version"], "sha256": "a" * 64, "filename": f"phishguard-extension-v{manifest['version']}.zip"}
    monkeypatch.setattr(artifact_storage, "get_latest_extension_build", mock_latest)
    client = TestClient(app)
    res = client.get("/download/extension")
    assert res.status_code == 200
    assert "application/zip" in res.headers["content-type"]
    assert "X-Extension-Version" in res.headers
    assert "X-Extension-SHA256" in res.headers
    assert res.headers["X-Extension-Version"] == manifest["version"]



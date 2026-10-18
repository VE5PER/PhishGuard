"""RustFS-based S3-compatible Artifact Storage Service for PhishGuard.

Provides high-performance artifact storage and distribution for:
1. Versioned ONNX model binaries (e.g. student_model_v1.1.0.onnx).
2. Extension distribution archives (.zip, .crx, updates.xml, extension-meta.json).
3. Forensic analysis payloads and visual artifacts.

Hosted by default at http://rustfs:9000/.
Supports AWS SigV4 signed requests as well as standard S3 REST endpoints.
"""

import os
import hmac
import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Dict, List, Optional, Tuple, Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)


def _sign_s3_v4_headers(
    method: str,
    url: str,
    headers: Dict[str, str],
    payload: bytes,
    access_key: str,
    secret_key: str,
    region: str = "us-east-1",
    service: str = "s3",
) -> Dict[str, str]:
    """Generates AWS SigV4 authorization headers for S3-compatible object storage."""
    parsed = urlparse(url)
    host = parsed.netloc
    path = parsed.path or "/"

    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(payload).hexdigest()

    # Base headers
    req_headers = dict(headers)
    req_headers["host"] = host
    req_headers["x-amz-date"] = amz_date
    req_headers["x-amz-content-sha256"] = payload_hash

    # Canonical headers
    sorted_header_keys = sorted(req_headers.keys())
    canonical_headers = "".join(f"{k.lower()}:{req_headers[k].strip()}\n" for k in sorted_header_keys)
    signed_headers = ";".join(k.lower() for k in sorted_header_keys)

    canonical_request = "\n".join([
        method.upper(),
        path,
        parsed.query,
        canonical_headers,
        signed_headers,
        payload_hash,
    ])

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    # Derivation keys
    def _sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    k_date = _sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    k_signing = _sign(k_service, "aws4_request")

    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    req_headers["Authorization"] = authorization
    return req_headers


class RustFSArtifactStorageService:
    """Manages artifact uploads, downloads, and streaming against RustFS (http://rustfs:9000/)."""

    def __init__(
        self,
        endpoint_url: Optional[str] = None,
        access_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        bucket: Optional[str] = None,
        region: Optional[str] = None,
    ):
        self.endpoint_url = (
            endpoint_url
            or os.environ.get("RUSTFS_ENDPOINT_URL")
            or "http://rustfs:9000"
        ).rstrip("/")
        self.access_key = access_key or os.environ.get("RUSTFS_ACCESS_KEY", "rustfsadmin")
        self.secret_key = secret_key or os.environ.get("RUSTFS_SECRET_KEY", "rustfsadmin")
        self.bucket = bucket or os.environ.get("RUSTFS_BUCKET", "phishguard-artifacts")
        self.region = region or os.environ.get("RUSTFS_REGION", "us-east-1")
        self._bucket_verified = False

    def _get_object_url(self, key: str) -> str:
        clean_key = key.lstrip("/")
        return f"{self.endpoint_url}/{self.bucket}/{clean_key}"

    def _get_bucket_url(self) -> str:
        return f"{self.endpoint_url}/{self.bucket}"

    def _prepare_headers(
        self,
        method: str,
        url: str,
        payload: bytes = b"",
        content_type: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        headers = dict(extra_headers or {})
        if content_type:
            headers["Content-Type"] = content_type

        if self.access_key and self.secret_key:
            return _sign_s3_v4_headers(
                method=method,
                url=url,
                headers=headers,
                payload=payload,
                access_key=self.access_key,
                secret_key=self.secret_key,
                region=self.region,
            )
        return headers

    async def is_healthy(self) -> bool:
        """Verifies if RustFS endpoint responds to health checks or root queries."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                # Try dedicated /health first
                health_url = f"{self.endpoint_url}/health"
                resp = await client.get(health_url)
                if resp.status_code < 500:
                    return True

                # Fallback to checking endpoint root
                root_resp = await client.get(self.endpoint_url)
                return root_resp.status_code < 500
        except Exception:
            return False

    async def ensure_bucket(self) -> bool:
        """Ensures the target artifact bucket exists in RustFS, creating it if needed."""
        if self._bucket_verified:
            return True

        url = self._get_bucket_url()
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                head_headers = self._prepare_headers("HEAD", url)
                res = await client.head(url, headers=head_headers)
                if res.status_code == 200:
                    self._bucket_verified = True
                    return True

                # Bucket does not exist, create it
                put_headers = self._prepare_headers("PUT", url)
                create_res = await client.put(url, headers=put_headers)
                if create_res.status_code in (200, 204, 409):
                    self._bucket_verified = True
                    return True
                logger.warning(f"RustFS bucket creation returned {create_res.status_code}: {create_res.text}")
                return False
        except Exception as e:
            logger.debug(f"Unable to verify/create RustFS bucket: {e}")
            return False

    async def upload_artifact(
        self,
        key: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        metadata: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Uploads an in-memory artifact blob to RustFS."""
        url = self._get_object_url(key)
        extra = {}
        if metadata:
            for k, v in metadata.items():
                extra[f"x-amz-meta-{k.lower()}"] = str(v)

        headers = self._prepare_headers("PUT", url, payload=data, content_type=content_type, extra_headers=extra)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.put(url, content=data, headers=headers)
                if res.status_code in (200, 201, 204):
                    logger.info(f"Uploaded artifact '{key}' to RustFS ({len(data)} bytes).")
                    return True
                logger.warning(f"RustFS upload failed for '{key}' ({res.status_code}): {res.text}")
                return False
        except Exception as e:
            logger.error(f"Error uploading artifact '{key}' to RustFS: {e}")
            return False

    async def upload_file(
        self,
        key: str,
        file_path: Path,
        content_type: str = "application/octet-stream",
        metadata: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Uploads an on-disk file to RustFS."""
        if not file_path.exists():
            return False
        data = file_path.read_bytes()
        return await self.upload_artifact(key, data, content_type=content_type, metadata=metadata)

    async def _upload_if_changed(
        self,
        key: str,
        file_path: Path,
        content_type: str = "application/octet-stream",
        metadata: Optional[Dict[str, str]] = None,
        skipped: Optional[List[str]] = None,
    ) -> bool:
        """Uploads a file only when the remote object's sha256 metadata differs."""
        expected_sha = (metadata or {}).get("sha256")
        remote_headers = await self.get_artifact_meta(key)
        if (
            remote_headers is not None
            and expected_sha
            and remote_headers.get("x-amz-meta-sha256") == expected_sha
        ):
            if skipped is not None:
                skipped.append(key)
            return True
        return await self.upload_file(key, file_path, content_type=content_type, metadata=metadata)

    async def get_artifact(self, key: str) -> Optional[Tuple[bytes, str, Dict[str, str]]]:
        """Retrieves raw artifact data, content type, and headers from RustFS."""
        url = self._get_object_url(key)
        headers = self._prepare_headers("GET", url)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    c_type = res.headers.get("content-type", "application/octet-stream")
                    return res.content, c_type, dict(res.headers)
                return None
        except Exception as e:
            logger.debug(f"Failed to fetch artifact '{key}' from RustFS: {e}")
            return None

    async def get_artifact_meta(self, key: str) -> Optional[Dict[str, str]]:
        """Retrieves object metadata headers (HEAD request) from RustFS."""
        url = self._get_object_url(key)
        headers = self._prepare_headers("HEAD", url)

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.head(url, headers=headers)
                if res.status_code == 200:
                    return dict(res.headers)
                return None
        except Exception:
            return None

    async def has_artifact(self, key: str) -> bool:
        """Checks if artifact exists in RustFS."""
        meta = await self.get_artifact_meta(key)
        return meta is not None

    async def stream_artifact(self, key: str, chunk_size: int = 65536) -> AsyncGenerator[bytes, None]:
        """Asynchronously streams artifact chunks directly from RustFS."""
        url = self._get_object_url(key)
        headers = self._prepare_headers("GET", url)

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("GET", url, headers=headers) as response:
                if response.status_code != 200:
                    return
                async for chunk in response.aiter_bytes(chunk_size):
                    yield chunk

    async def get_latest_extension_build(self) -> Optional[Dict[str, Any]]:
        """Queries the RustFS artifact bucket to find metadata for the latest extension build."""
        for key in ("extension/latest.json", "latest.json", "extension/extension-meta.json", "extension-meta.json"):
            artifact = await self.get_artifact(key)
            if artifact:
                data, _, _ = artifact
                try:
                    import json
                    return json.loads(data.decode("utf-8"))
                except Exception:
                    pass
        return None

    async def get_available_extension_versions(self, downloads_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
        """Discovers all published extension release versions from RustFS bucket and local disk cache."""
        import re

        version_map: Dict[str, Dict[str, Any]] = {}

        # 1. Inspect latest build metadata
        latest_build = await self.get_latest_extension_build()
        latest_version = latest_build.get("version", "0.1.0") if latest_build else "0.1.0"
        if latest_build:
            version_map[latest_version] = {
                "version": latest_version,
                "is_latest": True,
                "crx_download_url": latest_build.get("crx_download_url") or f"/download/version/{latest_version}/crx",
                "zip_download_url": latest_build.get("download_url") or f"/download/version/{latest_version}/zip",
                "sha256": latest_build.get("sha256"),
                "crx_sha256": latest_build.get("crx_sha256"),
                "built_at": latest_build.get("built_at"),
            }

        # 2. Check local downloads directory
        if downloads_dir and downloads_dir.exists():
            for p in downloads_dir.iterdir():
                m = re.match(r"phishguard-extension-v([\d\.]+)\.(zip|crx)", p.name)
                if m:
                    ver = m.group(1)
                    if ver not in version_map:
                        version_map[ver] = {
                            "version": ver,
                            "is_latest": (ver == latest_version),
                            "crx_download_url": f"/download/version/{ver}/crx",
                            "zip_download_url": f"/download/version/{ver}/zip",
                        }
                    if m.group(2) == "crx":
                        version_map[ver]["crx_download_url"] = f"/download/version/{ver}/crx"
                    elif m.group(2) == "zip":
                        version_map[ver]["zip_download_url"] = f"/download/version/{ver}/zip"

        # Fallback default if nothing found
        if not version_map:
            version_map["0.1.0"] = {
                "version": "0.1.0",
                "is_latest": True,
                "crx_download_url": "/download/crx",
                "zip_download_url": "/download/extension",
            }

        def ver_key(v_str: str):
            clean = v_str.lstrip("v")
            parts = [int(p) if p.isdigit() else 0 for p in clean.split(".")]
            while len(parts) < 3:
                parts.append(0)
            return parts

        sorted_versions = sorted(version_map.values(), key=lambda x: ver_key(x["version"]), reverse=True)
        if sorted_versions:
            for v in sorted_versions:
                v["is_latest"] = (v["version"] == sorted_versions[0]["version"])

        return sorted_versions

    async def sync_local_artifacts(self, downloads_dir: Path, models_dir: Optional[Path] = None) -> Dict[str, Any]:
        """Syncs all available local packages and ONNX models into RustFS artifact storage."""
        synced = []
        skipped = []
        errors = []

        await self.ensure_bucket()

        # 1. Extension downloads
        if downloads_dir.exists():
            import json
            meta_path = downloads_dir / "extension-meta.json"
            ext_meta = {}
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        ext_meta = json.load(f)
                except Exception:
                    pass

            for item in downloads_dir.iterdir():
                if item.is_file():
                    key = f"extension/{item.name}"
                    c_type = "application/octet-stream"
                    file_sha = hashlib.sha256(item.read_bytes()).hexdigest()
                    metadata = {"sha256": file_sha}
                    if item.suffix == ".zip":
                        c_type = "application/zip"
                    elif item.suffix == ".crx":
                        c_type = "application/x-chrome-extension"
                        if "extension_id" in ext_meta:
                            metadata["extension_id"] = ext_meta["extension_id"]
                    elif item.suffix == ".xml":
                        c_type = "application/xml"
                    elif item.suffix == ".json":
                        c_type = "application/json"

                    try:
                        ok = await self._upload_if_changed(
                            key, item, content_type=c_type, metadata=metadata, skipped=skipped
                        )
                        if ok:
                            synced.append(key)
                        # Also mirror to root key for flat URLs
                        await self._upload_if_changed(
                            item.name, item, content_type=c_type, metadata=metadata, skipped=skipped
                        )
                    except Exception as e:
                        errors.append(f"{key}: {e}")

        # 2. ONNX models
        if models_dir and models_dir.exists():
            for onnx_file in models_dir.glob("**/*.onnx"):
                rel_path = onnx_file.relative_to(models_dir)
                key = f"models/{rel_path.as_posix()}"
                try:
                    m_sha = hashlib.sha256(onnx_file.read_bytes()).hexdigest()
                    ok = await self._upload_if_changed(
                        key,
                        onnx_file,
                        content_type="application/octet-stream",
                        metadata={"sha256": m_sha},
                        skipped=skipped,
                    )
                    if ok:
                        synced.append(key)
                except Exception as e:
                    errors.append(f"{key}: {e}")

        return {"synced": synced, "skipped": skipped, "errors": errors, "total": len(synced)}


# Global singleton instance
artifact_storage = RustFSArtifactStorageService()

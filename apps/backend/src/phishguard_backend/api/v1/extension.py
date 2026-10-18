"""Extension distribution API endpoints for client downloads and cryptographic verification."""

import json
from pathlib import Path
from typing import Any, Dict
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

router = APIRouter(prefix="/v1/extension", tags=["extension"])

import os

def _get_downloads_dir() -> Path:
    if os.environ.get("STATIC_DIR"):
        return Path(os.environ["STATIC_DIR"]) / "downloads"
    candidates = [
        Path(__file__).resolve().parents[4] / "static" / "downloads",
        Path.cwd() / "apps" / "backend" / "static" / "downloads",
        Path.cwd() / "static" / "downloads",
        Path("/app/apps/backend/static/downloads"),
        Path("/tmp/phishguard_static/downloads"),
    ]
    for candidate in candidates:
        if (candidate / "phishguard-extension.zip").exists():
            return candidate
    for candidate in candidates:
        if candidate.exists() or candidate.parent.exists():
            return candidate
    return Path.cwd() / "static" / "downloads"

DOWNLOADS_DIR = _get_downloads_dir()


def get_extension_meta() -> Dict[str, Any]:
    """Retrieves cached or generated extension release metadata."""
    meta_path = DOWNLOADS_DIR / "extension-meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    zip_path = DOWNLOADS_DIR / "phishguard-extension.zip"
    if zip_path.exists():
        import hashlib
        hasher = hashlib.sha256()
        with open(zip_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        size_bytes = zip_path.stat().st_size
        return {
            "name": "PhishGuard Browser Extension",
            "version": "0.1.0",
            "filename": "phishguard-extension.zip",
            "download_url": "/download/extension",
            "sha256": hasher.hexdigest(),
            "size_bytes": size_bytes,
            "size_formatted": f"{size_bytes / (1024 * 1024):.2f} MB",
            "supported_browsers": [
                "Google Chrome (113+)",
                "Brave Browser",
                "Microsoft Edge",
                "Opera / Chromium MV3",
            ],
            "installation_type": "Unpacked Manifest V3 Extension",
        }

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Extension package not yet built or distributed.",
    )


from ...services.storage import artifact_storage
from phishguard_types.extension import ExtensionVersionsList, ExtensionVersionItem


@router.get("/latest")
async def get_latest_extension_info() -> Dict[str, Any]:
    """Retrieve metadata, version, and SHA-256 hash for the latest packaged extension release from RustFS or disk."""
    # 1. Query RustFS bucket for latest build info
    bucket_meta = await artifact_storage.get_latest_extension_build()
    if bucket_meta:
        return bucket_meta

    # 2. Fallback to local disk metadata
    return get_extension_meta()


@router.get("/versions", response_model=ExtensionVersionsList)
async def list_extension_versions() -> ExtensionVersionsList:
    """List all available packaged extension versions for install, update, or downgrade."""
    versions_data = await artifact_storage.get_available_extension_versions(downloads_dir=DOWNLOADS_DIR)
    latest_ver = versions_data[0]["version"] if versions_data else None
    return ExtensionVersionsList(
        versions=[ExtensionVersionItem(**v) for v in versions_data],
        latest=latest_ver,
    )


"""FastAPI Main Application Entrypoint for PhishGuard Gateway."""

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles

from .api.v1.escalate import router as escalate_router
from .api.v1.models import router as models_router
from .api.v1.playground import router as playground_router
from .api.v1.extension import router as extension_router
from .db import init_db, async_session_maker
from .services.gemini_agent import GeminiTeacherConfig, circuit_breaker
from .services.model_registry import model_registry
from .services.storage import artifact_storage

import os

def _get_static_dir() -> Path:
    if os.environ.get("STATIC_DIR"):
        p = Path(os.environ["STATIC_DIR"])
        p.mkdir(parents=True, exist_ok=True)
        return p

    candidates = [
        Path(__file__).resolve().parent.parent.parent / "static",
        Path.cwd() / "apps" / "backend" / "static",
        Path.cwd() / "static",
        Path("/app/apps/backend/static"),
        Path("/tmp/phishguard_static"),
    ]
    for candidate in candidates:
        try:
            if (candidate / "index.html").exists():
                return candidate
        except OSError:
            continue

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue
    return Path.cwd() / "static"

STATIC_DIR = _get_static_dir()
DOWNLOADS_DIR = STATIC_DIR / "downloads"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database tables, sync model registry, and configure RustFS artifact storage on startup."""
    await init_db()
    async with async_session_maker() as session:
        await model_registry.sync_with_db(session)
    try:
        await artifact_storage.ensure_bucket()
        await artifact_storage.sync_local_artifacts(DOWNLOADS_DIR, model_registry.models_dir)
    except Exception:
        pass
    yield


app = FastAPI(
    title="PhishGuard Escalation Gateway",
    version="0.1.0",
    description="Cloud Orchestration Gateway and Cloud Teacher Inference Service for PhishGuard",
    lifespan=lifespan,
)

# Enable CORS for browser extension communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)

# API Routers
@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Report validation failures without echoing request values (e.g. consented screenshots)."""
    details = [{key: value for key, value in error.items() if key not in ("input", "ctx")} for error in exc.errors()]
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"detail": jsonable_encoder(details)})


app.include_router(escalate_router)
app.include_router(playground_router)
app.include_router(models_router)
app.include_router(extension_router)


@app.get("/health", tags=["system"])
async def health_check():
    """System health check endpoint."""
    teacher_config = GeminiTeacherConfig.from_env()
    return {
        "status": "healthy",
        "capabilities": {
            "telemetryEvidenceVersion": 2,
            "modelInputContracts": ["student-v1", "student-v2"],
            "manualEscalation": True,
        },
        "cloudTeacher": {
            "provider": "gemini-adk",
            "model": teacher_config.model,
            "configured": teacher_config.configured,
            "circuit": circuit_breaker.state,
        },
    }


async def _get_extension_zip_response(version: Optional[str] = None) -> Response:
    """Query RustFS artifact storage for the latest build version and stream it with fallback to local disk."""
    # 1. Query latest build metadata from RustFS bucket
    latest_build = await artifact_storage.get_latest_extension_build()
    target_version = version or (latest_build.get("version") if latest_build else None)

    candidate_keys = []
    if target_version:
        candidate_keys.extend([
            f"extension/phishguard-extension-v{target_version}.zip",
            f"extension/versions/{target_version}/phishguard-extension-v{target_version}.zip",
            f"extension/versions/{target_version}/phishguard-extension.zip",
            f"phishguard-extension-v{target_version}.zip",
        ])
    candidate_keys.extend(["extension/phishguard-extension.zip", "phishguard-extension.zip"])

    for key in candidate_keys:
        meta = await artifact_storage.get_artifact_meta(key)
        if meta:
            effective_ver = target_version or (latest_build.get("version") if latest_build else "0.1.0")
            sha256 = meta.get("x-amz-meta-sha256")
            if not sha256 or len(sha256) != 64:
                if latest_build and latest_build.get("sha256") and len(latest_build["sha256"]) == 64:
                    sha256 = latest_build["sha256"]
                else:
                    meta_path = DOWNLOADS_DIR / "extension-meta.json"
                    if meta_path.exists():
                        try:
                            with open(meta_path, "r", encoding="utf-8") as f:
                                sha256 = json.load(f).get("sha256")
                        except Exception:
                            pass
            if not sha256 or len(sha256) != 64:
                zip_path = DOWNLOADS_DIR / "phishguard-extension.zip"
                if zip_path.exists():
                    import hashlib
                    hasher = hashlib.sha256()
                    with open(zip_path, "rb") as f:
                        for chunk in iter(lambda: f.read(65536), b""):
                            hasher.update(chunk)
                    sha256 = hasher.hexdigest()
                else:
                    sha256 = meta.get("etag", "unknown").strip('"')

            fn = f"phishguard-extension-v{target_version}.zip" if target_version else "phishguard-extension.zip"
            headers = {
                "Content-Disposition": f'attachment; filename="{fn}"',
                "X-Extension-Version": str(effective_ver),
                "X-Extension-SHA256": sha256,
                "X-Storage-Backend": "rustfs",
                "Cache-Control": "public, max-age=3600",
            }
            if "content-length" in meta:
                headers["Content-Length"] = meta["content-length"]
            return StreamingResponse(
                artifact_storage.stream_artifact(key),
                media_type="application/zip",
                headers=headers,
            )

    # 2. Fallback to local disk
    target_fn = f"phishguard-extension-v{target_version}.zip" if target_version else "phishguard-extension.zip"
    zip_path = DOWNLOADS_DIR / target_fn
    if not zip_path.exists():
        zip_path = DOWNLOADS_DIR / "phishguard-extension.zip"
    if not zip_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Packaged extension archive not found in RustFS or on disk. Run packaging pipeline first.",
        )

    sha256 = "unknown"
    ver = target_version or "0.1.0"
    meta_path = DOWNLOADS_DIR / "extension-meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_json = json.load(f)
                if not target_version:
                    ver = meta_json.get("version", "0.1.0")
                    sha256 = meta_json.get("sha256", "unknown")
                elif meta_json.get("version") == target_version:
                    sha256 = meta_json.get("sha256", "unknown")
        except Exception:
            pass

    if sha256 == "unknown":
        import hashlib
        hasher = hashlib.sha256()
        with open(zip_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        sha256 = hasher.hexdigest()

    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=target_fn,
        headers={
            "Content-Disposition": f'attachment; filename="{target_fn}"',
            "X-Extension-Version": str(ver),
            "X-Extension-SHA256": sha256,
            "X-Storage-Backend": "local-fallback",
            "Cache-Control": "public, max-age=3600",
        },
    )


async def _get_extension_crx_response(version: Optional[str] = None) -> Response:
    """Query RustFS artifact storage for the latest CRX build version and stream it with disk fallback."""
    latest_build = await artifact_storage.get_latest_extension_build()
    target_version = version or (latest_build.get("version") if latest_build else None)

    candidate_keys = []
    if target_version:
        candidate_keys.extend([
            f"extension/phishguard-extension-v{target_version}.crx",
            f"extension/versions/{target_version}/phishguard-extension-v{target_version}.crx",
            f"extension/versions/{target_version}/phishguard-extension.crx",
            f"phishguard-extension-v{target_version}.crx",
        ])
    candidate_keys.extend(["extension/phishguard-extension.crx", "phishguard-extension.crx"])

    for key in candidate_keys:
        meta = await artifact_storage.get_artifact_meta(key)
        if meta:
            effective_ver = target_version or (latest_build.get("version") if latest_build else "0.1.0")
            sha256 = meta.get("x-amz-meta-sha256")
            ext_id = meta.get("x-amz-meta-extension_id")
            if latest_build:
                if not ext_id or ext_id == "unknown":
                    ext_id = latest_build.get("extension_id")
                if not sha256 or len(sha256) != 64:
                    sha256 = latest_build.get("crx_sha256")

            if not ext_id or ext_id == "unknown" or not sha256 or len(sha256) != 64:
                meta_path = DOWNLOADS_DIR / "extension-meta.json"
                if meta_path.exists():
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta_json = json.load(f)
                            if not ext_id or ext_id == "unknown":
                                ext_id = meta_json.get("extension_id", "unknown")
                            if not sha256 or len(sha256) != 64:
                                sha256 = meta_json.get("crx_sha256", "unknown")
                    except Exception:
                        pass
            if not sha256 or len(sha256) != 64:
                crx_path = DOWNLOADS_DIR / "phishguard-extension.crx"
                if crx_path.exists():
                    import hashlib
                    hasher = hashlib.sha256()
                    with open(crx_path, "rb") as f:
                        for chunk in iter(lambda: f.read(65536), b""):
                            hasher.update(chunk)
                    sha256 = hasher.hexdigest()
                else:
                    sha256 = meta.get("etag", "unknown").strip('"')

            fn = f"phishguard-extension-v{target_version}.crx" if target_version else "phishguard-extension.crx"
            headers = {
                "Content-Disposition": f'attachment; filename="{fn}"',
                "X-Extension-Version": str(effective_ver),
                "X-Extension-ID": ext_id or "unknown",
                "X-Extension-SHA256": sha256,
                "X-Storage-Backend": "rustfs",
                "Cache-Control": "public, max-age=3600",
            }
            if "content-length" in meta:
                headers["Content-Length"] = meta["content-length"]
            return StreamingResponse(
                artifact_storage.stream_artifact(key),
                media_type="application/x-chrome-extension",
                headers=headers,
            )

    target_fn = f"phishguard-extension-v{target_version}.crx" if target_version else "phishguard-extension.crx"
    crx_path = DOWNLOADS_DIR / target_fn
    if not crx_path.exists():
        crx_path = DOWNLOADS_DIR / "phishguard-extension.crx"
    if not crx_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Signed .crx package not found in RustFS or on disk. Run packaging pipeline first.",
        )

    sha256 = "unknown"
    ext_id = "unknown"
    ver = target_version or "0.1.0"
    meta_path = DOWNLOADS_DIR / "extension-meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_json = json.load(f)
                ext_id = meta_json.get("extension_id", "unknown")
                if not target_version:
                    ver = meta_json.get("version", "0.1.0")
                    sha256 = meta_json.get("crx_sha256", "unknown")
                elif meta_json.get("version") == target_version:
                    sha256 = meta_json.get("crx_sha256", "unknown")
        except Exception:
            pass

    if sha256 == "unknown":
        import hashlib
        hasher = hashlib.sha256()
        with open(crx_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        sha256 = hasher.hexdigest()

    return FileResponse(
        path=str(crx_path),
        media_type="application/x-chrome-extension",
        filename=target_fn,
        headers={
            "Content-Disposition": f'attachment; filename="{target_fn}"',
            "X-Extension-ID": ext_id,
            "X-Extension-Version": str(ver),
            "X-Extension-SHA256": sha256,
            "X-Storage-Backend": "local-fallback",
            "Cache-Control": "public, max-age=3600",
        },
    )


async def _get_extension_webstore_zip_response() -> Response:
    """Serve the Chrome Web Store zip (manifest without key/update_url) from RustFS with disk fallback."""
    for key in ("extension/phishguard-extension-webstore.zip", "phishguard-extension-webstore.zip"):
        meta = await artifact_storage.get_artifact_meta(key)
        if meta:
            headers = {
                "Content-Disposition": 'attachment; filename="phishguard-extension-webstore.zip"',
                "X-Storage-Backend": "rustfs",
                "Cache-Control": "public, max-age=3600",
            }
            if "content-length" in meta:
                headers["Content-Length"] = meta["content-length"]
            return StreamingResponse(
                artifact_storage.stream_artifact(key),
                media_type="application/zip",
                headers=headers,
            )

    zip_path = DOWNLOADS_DIR / "phishguard-extension-webstore.zip"
    if not zip_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chrome Web Store zip not found in RustFS or on disk. Run packaging pipeline first.",
        )
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename="phishguard-extension-webstore.zip",
        headers={
            "Content-Disposition": 'attachment; filename="phishguard-extension-webstore.zip"',
            "X-Storage-Backend": "local-fallback",
            "Cache-Control": "public, max-age=3600",
        },
    )


async def _get_updates_xml_response() -> Response:
    """Helper to serve the Chromium updates.xml manifest from RustFS or local disk fallback."""
    for key in ("extension/updates.xml", "updates.xml"):
        meta = await artifact_storage.get_artifact_meta(key)
        if meta:
            headers = {
                "X-Storage-Backend": "rustfs",
                "Cache-Control": "public, max-age=300",
            }
            if "content-length" in meta:
                headers["Content-Length"] = meta["content-length"]
            return StreamingResponse(
                artifact_storage.stream_artifact(key),
                media_type="application/xml",
                headers=headers,
            )

    xml_path = DOWNLOADS_DIR / "updates.xml"
    if not xml_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Autoupdate manifest updates.xml not found in RustFS or on disk. Run packaging pipeline first.",
        )
    return FileResponse(
        path=str(xml_path),
        media_type="application/xml",
        filename="updates.xml",
        headers={
            "X-Storage-Backend": "local-fallback",
            "Cache-Control": "public, max-age=300",
        },
    )


@app.api_route("/download", methods=["GET", "HEAD"], tags=["distribution"])
@app.api_route("/download/extension", methods=["GET", "HEAD"], tags=["distribution"])
@app.api_route("/download/phishguard-extension.zip", methods=["GET", "HEAD"], tags=["distribution"])
async def download_extension_zip():
    """Download the Chrome Web Store submission / unpacked zip archive from RustFS or local cache."""
    return await _get_extension_zip_response()


@app.api_route("/download/crx", methods=["GET", "HEAD"], tags=["distribution"])
@app.api_route("/download/phishguard-extension.crx", methods=["GET", "HEAD"], tags=["distribution"])
async def download_extension_crx():
    """Download the cryptographically signed standalone Chromium CRX extension package."""
    return await _get_extension_crx_response()


@app.api_route("/download/phishguard-extension-v{version}.crx", methods=["GET", "HEAD"], tags=["distribution"])
async def download_versioned_extension_crx(version: str):
    """Download a version-pinned CRX; this is the absolute codebase target referenced by updates.xml."""
    return await _get_extension_crx_response(version=version)


@app.api_route("/download/phishguard-extension-webstore.zip", methods=["GET", "HEAD"], tags=["distribution"])
async def download_extension_webstore_zip():
    """Download the Chrome Web Store upload zip (no manifest key / update_url)."""
    return await _get_extension_webstore_zip_response()


@app.api_route("/updates.xml", methods=["GET", "HEAD"], tags=["distribution"])
@app.api_route("/download/updates.xml", methods=["GET", "HEAD"], tags=["distribution"])
async def extension_updates_manifest():
    """Serve Chromium autoupdate protocol 2.0 XML manifest."""
    return await _get_updates_xml_response()


@app.api_route("/download/version/latest", methods=["GET"], tags=["distribution"])
async def download_latest_version_info():
    """Query and return metadata for the latest extension build version stored in the bucket."""
    latest_build = await artifact_storage.get_latest_extension_build()
    if not latest_build:
        meta_path = DOWNLOADS_DIR / "extension-meta.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No extension build metadata found in bucket or on disk",
        )
    return latest_build


@app.api_route("/download/versions", methods=["GET"], tags=["distribution"])
async def download_versions_list():
    """List all available extension versions in the distribution repository."""
    versions_data = await artifact_storage.get_available_extension_versions(downloads_dir=DOWNLOADS_DIR)
    latest_ver = versions_data[0]["version"] if versions_data else None
    return {
        "versions": versions_data,
        "latest": latest_ver,
    }


@app.api_route("/download/version/{version}/zip", methods=["GET", "HEAD"], tags=["distribution"])
async def download_specific_version_zip(version: str):
    """Download a specific build version ZIP archive from the bucket."""
    return await _get_extension_zip_response(version=version)


@app.api_route("/download/version/{version}/crx", methods=["GET", "HEAD"], tags=["distribution"])
async def download_specific_version_crx(version: str):
    """Download a specific build version CRX package from the bucket."""
    return await _get_extension_crx_response(version=version)


@app.api_route("/v1/artifacts/{artifact_path:path}", methods=["GET", "HEAD"], tags=["storage"])
async def get_artifact_endpoint(artifact_path: str):
    """Retrieve an arbitrary artifact from RustFS artifact storage with streaming."""
    meta = await artifact_storage.get_artifact_meta(artifact_path)
    if not meta:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Artifact '{artifact_path}' not found in RustFS storage",
        )
    c_type = meta.get("content-type", "application/octet-stream")
    headers = {
        "X-Storage-Backend": "rustfs",
        "Cache-Control": "public, max-age=3600",
    }
    if "etag" in meta:
        headers["ETag"] = meta["etag"]
    if "content-length" in meta:
        headers["Content-Length"] = meta["content-length"]
    return StreamingResponse(
        artifact_storage.stream_artifact(artifact_path),
        media_type=c_type,
        headers=headers,
    )


# Mount StaticFiles at root for the landing page and client assets
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

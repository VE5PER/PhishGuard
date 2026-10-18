"""Model Registry API endpoints for client synchronization and binary distribution."""

from typing import List
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse, StreamingResponse

from phishguard_types import (
    ModelMetadata,
    CheckUpdateRequest,
    CheckUpdateResponse,
)
from phishguard_backend.services.model_registry import model_registry
from phishguard_backend.services.storage import artifact_storage

router = APIRouter(prefix="/v1/models", tags=["models"])


@router.get("/latest", response_model=ModelMetadata)
async def get_latest_model() -> ModelMetadata:
    """Retrieve metadata and cryptographic specs for the latest available student model."""
    latest = model_registry.get_latest()
    if not latest:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No models registered in registry",
        )
    return latest


@router.get("/versions", response_model=List[ModelMetadata])
async def list_model_versions() -> List[ModelMetadata]:
    """List metadata for all released student model versions, sorted newest to oldest."""
    return model_registry.list_all()


@router.get("/{version}", response_model=ModelMetadata)
async def get_model_by_version(version: str) -> ModelMetadata:
    """Retrieve metadata for a specific model SemVer."""
    meta = model_registry.get_metadata(version)
    if not meta:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model version '{version}' not found in registry",
        )
    return meta


@router.api_route("/{version}/download", methods=["GET", "HEAD"])
async def download_model_binary(version: str):
    """Stream versioned ONNX model binary to the client with SHA-256 ETag verification from RustFS or disk."""
    meta = model_registry.get_metadata(version)
    etag = meta.sha256 if meta else "unknown"

    # 1. Try RustFS artifact storage
    potential_keys = [
        f"models/v{version}/student_model.onnx",
        f"models/{version}/student_model.onnx",
        f"models/student_model_{version}.onnx",
        f"student_model_{version}.onnx",
    ]
    for key in potential_keys:
        s_meta = await artifact_storage.get_artifact_meta(key)
        if s_meta:
            headers = {
                "ETag": f'"{etag}"',
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Model-Version": version,
                "X-Model-SHA256": etag,
                "X-Storage-Backend": "rustfs",
            }
            if "content-length" in s_meta:
                headers["Content-Length"] = s_meta["content-length"]
            return StreamingResponse(
                artifact_storage.stream_artifact(key),
                media_type="application/octet-stream",
                headers=headers,
            )

    # 2. Fallback to local on-disk binary
    bin_path = model_registry.get_binary_path(version)
    if not bin_path or not bin_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Binary file for model version '{version}' is not available in RustFS or on disk",
        )

    return FileResponse(
        path=str(bin_path),
        media_type="application/octet-stream",
        filename=f"student_model_{version}.onnx",
        headers={
            "ETag": f'"{etag}"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Model-Version": version,
            "X-Model-SHA256": etag,
            "X-Storage-Backend": "local-fallback",
        },
    )


@router.post("/check-update", response_model=CheckUpdateResponse)
async def check_model_update(payload: CheckUpdateRequest) -> CheckUpdateResponse:
    """Check if a newer model version or updated binary is available for the client."""
    try:
        return model_registry.check_update(
            current_version=payload.currentVersion,
            current_sha256=payload.currentSha256,
            extension_version=payload.extensionVersion,
            supported_input_contracts=payload.supportedInputContracts,
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No compatible model release is available",
        )

#!/usr/bin/env python3
"""Create and upload dummy student model (v1.2.0) to RustFS artifact store."""

import asyncio
import hashlib
import os
from pathlib import Path
import sys

# Ensure repository packages are importable
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "ml-engine" / "src"))
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend" / "src"))

from phishguard_ml_engine.export.export_onnx import export_student_to_onnx
from phishguard_backend.services.storage import RustFSArtifactStorageService


async def main():
    version = "1.2.0"
    print(f"[PhishGuard] Creating dummy model for version {version}...")

    # Output paths
    scratch_dir = REPO_ROOT / "scratch"
    scratch_dir.mkdir(exist_ok=True)
    dummy_onnx_path = scratch_dir / f"student_model_v{version}.onnx"

    # Export valid ONNX student model
    export_student_to_onnx(output_path=str(dummy_onnx_path), seq_length=128, include_visual=False)

    # Compute checksum and size
    model_bytes = dummy_onnx_path.read_bytes()
    file_size = len(model_bytes)
    sha256 = hashlib.sha256(model_bytes).hexdigest()
    print(f"[PhishGuard] Generated model binary: {file_size} bytes | SHA-256: {sha256}")

    # Copy to backend and ml-lifecycle models directories for disk fallback
    backend_model_dir = REPO_ROOT / "apps" / "backend" / "models" / f"v{version}"
    backend_model_dir.mkdir(parents=True, exist_ok=True)
    (backend_model_dir / "student_model.onnx").write_bytes(model_bytes)

    lifecycle_model_dir = REPO_ROOT / "apps" / "ml-lifecycle" / "checkpoints" / "registry" / f"v{version}"
    lifecycle_model_dir.mkdir(parents=True, exist_ok=True)
    (lifecycle_model_dir / "student_model.onnx").write_bytes(model_bytes)
    print(f"[PhishGuard] Copied model to local registry folders: {backend_model_dir}")

    # Connect to RustFS
    endpoints = ["http://localhost:9000", "http://rustfs:9000"]
    connected_storage = None
    for ep in endpoints:
        storage = RustFSArtifactStorageService(
            endpoint_url=ep,
            access_key=os.environ.get("RUSTFS_ACCESS_KEY", "rustfsadmin"),
            secret_key=os.environ.get("RUSTFS_SECRET_KEY", "rustfsadmin"),
            bucket="phishguard-artifacts",
        )
        if await storage.is_healthy():
            connected_storage = storage
            print(f"[PhishGuard] Successfully connected to RustFS at {ep}")
            break

    if not connected_storage:
        print("[PhishGuard] Warning: Could not connect to RustFS on localhost:9000 or rustfs:9000.")
        return 1

    # Ensure bucket and upload to target keys
    await connected_storage.ensure_bucket()

    keys = [
        f"models/v{version}/student_model.onnx",
        f"models/{version}/student_model.onnx",
        f"models/student_model_{version}.onnx",
        f"student_model_{version}.onnx",
    ]

    for key in keys:
        ok = await connected_storage.upload_artifact(
            key=key,
            data=model_bytes,
            content_type="application/octet-stream",
            metadata={"sha256": sha256, "version": version},
        )
        if ok:
            print(f"[PhishGuard] -> Uploaded key to RustFS: {key}")
        else:
            print(f"[PhishGuard] -> Failed to upload key to RustFS: {key}")

    # Also upload to dev-1 bucket if different
    dev_bucket = os.environ.get("RUSTFS_BUCKET", "phishguard-artifacts-dev-1")
    if dev_bucket != "phishguard-artifacts":
        dev_storage = RustFSArtifactStorageService(
            endpoint_url=connected_storage.endpoint_url,
            access_key=connected_storage.access_key,
            secret_key=connected_storage.secret_key,
            bucket=dev_bucket,
        )
        await dev_storage.ensure_bucket()
        for key in keys:
            await dev_storage.upload_artifact(
                key=key,
                data=model_bytes,
                content_type="application/octet-stream",
                metadata={"sha256": sha256, "version": version},
            )
        print(f"[PhishGuard] -> Synced model to bucket: {dev_bucket}")

    # Verification: check if key is retrievable
    meta = await connected_storage.get_artifact_meta(f"models/v{version}/student_model.onnx")
    if meta:
        print(f"[PhishGuard] Verification PASSED: RustFS object verified (Status 200, Content-Length: {meta.get('content-length')})")
    else:
        print("[PhishGuard] Verification FAILED: Could not retrieve object metadata from RustFS")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

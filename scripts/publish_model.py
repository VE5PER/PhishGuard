#!/usr/bin/env python3
"""Publish and synchronize a PhishGuard student model across RustFS, backend registry, and extension build."""

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys

# Ensure repository packages are importable
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "ml-engine" / "src"))
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend" / "src"))

from phishguard_backend.services.storage import RustFSArtifactStorageService


async def upload_to_rustfs(
    model_bytes: bytes,
    version: str,
    sha256: str,
    endpoint_url: str,
    buckets: list[str],
) -> None:
    keys = [
        f"models/v{version}/student_model.onnx",
        f"models/{version}/student_model.onnx",
        f"models/student_model_{version}.onnx",
        f"student_model_{version}.onnx",
    ]

    for bucket in buckets:
        storage = RustFSArtifactStorageService(
            endpoint_url=endpoint_url,
            access_key=os.environ.get("RUSTFS_ACCESS_KEY", "rustfsadmin"),
            secret_key=os.environ.get("RUSTFS_SECRET_KEY", "rustfsadmin"),
            bucket=bucket,
        )
        if not await storage.is_healthy():
            print(f"[RustFS] Warning: Bucket '{bucket}' on {endpoint_url} is not reachable or healthy. Skipping.")
            continue

        await storage.ensure_bucket()
        print(f"[RustFS] Connected to '{bucket}' on {endpoint_url}. Uploading {len(keys)} keys...")
        for key in keys:
            ok = await storage.upload_artifact(
                key=key,
                data=model_bytes,
                content_type="application/octet-stream",
                metadata={"sha256": sha256, "version": version},
            )
            status = "✓" if ok else "✗"
            print(f"  [{status}] s3://{bucket}/{key}")


def sync_local_backend(model_bytes: bytes, version: str) -> Path:
    target_dir = REPO_ROOT / "apps" / "backend" / "models" / f"v{version}"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / "student_model.onnx"
    target_file.write_bytes(model_bytes)
    print(f"[Backend Registry] Synced ONNX binary to: {target_file}")
    return target_file


def sync_extension_build(model_bytes: bytes, metadata_path: Path | None = None) -> None:
    ext_models_dir = REPO_ROOT / "apps" / "extension" / "public" / "models"
    ext_models_dir.mkdir(parents=True, exist_ok=True)
    ext_model_file = ext_models_dir / "student_model.onnx"
    ext_model_file.write_bytes(model_bytes)
    print(f"[Extension Build] Synced ONNX binary to: {ext_model_file}")

    if metadata_path and metadata_path.exists():
        ext_meta_file = ext_models_dir / "student_model.metadata.json"
        ext_meta_file.write_bytes(metadata_path.read_bytes())
        print(f"[Extension Build] Synced metadata to: {ext_meta_file}")


def main():
    parser = argparse.ArgumentParser(description="Publish PhishGuard student ONNX model")
    parser.add_argument("--model", type=str, required=True, help="Path to student_model.onnx")
    parser.add_argument("--version", type=str, default="2.0.0", help="Model version SemVer (e.g. 2.0.0)")
    parser.add_argument("--metadata", type=str, default=None, help="Optional path to student_model.metadata.json")
    parser.add_argument("--rustfs-url", type=str, default=os.environ.get("RUSTFS_ENDPOINT_URL", "http://localhost:9000"), help="RustFS endpoint URL")
    parser.add_argument("--buckets", nargs="+", default=["phishguard-artifacts", "phishguard-artifacts-dev-1", "phishguard-artifacts-dev-2"], help="RustFS buckets to sync")
    parser.add_argument("--update-extension", action="store_true", help="Also update apps/extension/public/models for the next extension build")
    args = parser.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"Error: Model file '{model_path}' does not exist.", file=sys.stderr)
        sys.exit(1)

    model_bytes = model_path.read_bytes()
    sha256 = hashlib.sha256(model_bytes).hexdigest()
    print("=" * 65)
    print(f" PhishGuard Model Publisher (v{args.version})")
    print(f" Source: {model_path} ({len(model_bytes)} bytes)")
    print(f" SHA-256: {sha256}")
    print("=" * 65)

    # 1. Backend local registry sync
    sync_local_backend(model_bytes, args.version)

    # 2. Extension build sync (optional)
    if args.update_extension:
        meta_path = Path(args.metadata) if args.metadata else None
        sync_extension_build(model_bytes, meta_path)

    # 3. RustFS S3 sync
    print(f"\n[RustFS] Syncing to {args.rustfs_url} across buckets: {args.buckets}")
    asyncio.run(upload_to_rustfs(
        model_bytes=model_bytes,
        version=args.version,
        sha256=sha256,
        endpoint_url=args.rustfs_url,
        buckets=args.buckets,
    ))

    print("\n" + "=" * 65)
    print("Publishing and synchronization complete!")


if __name__ == "__main__":
    main()

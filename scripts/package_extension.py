"""PhishGuard Chromium Extension Packaging and Distribution Pipeline.

Produces:
1. Chrome Web Store submission ZIP package (manifest without `key` / `update_url`).
2. Unpacked-install ZIP package (stable ID via manifest `key`, with `update_url`).
3. Cryptographically signed standalone Chromium CRX package.
4. Chromium autoupdate manifest (updates.xml) with an absolute codebase URL.
5. Machine-readable extension metadata (extension-meta.json).

The CRX signing key is never generated here: a new key means a new extension ID and
breaks updates for every existing install. Provide it via EXTENSION_SIGNING_KEY_FILE,
EXTENSION_SIGNING_KEY_B64, or the local untracked deploy/extension/phishguard-extension.pem.
Use --local-only to update disk downloads without uploading to RustFS.
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT_DIR / "apps" / "extension"
BACKEND_STATIC_DOWNLOADS = ROOT_DIR / "apps" / "backend" / "static" / "downloads"
BUILD_DIR = ROOT_DIR / "build"
KEYS_DIR = ROOT_DIR / "deploy" / "extension"
PEM_KEY_PATH = KEYS_DIR / "phishguard-extension.pem"


def format_file_size(size_bytes: int) -> str:
    """Formats raw byte count into human-readable MB/KB string."""
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.2f} MB"
    return f"{size_bytes / 1024:.1f} KB"


def compute_sha256(file_path: Path) -> str:
    """Computes SHA-256 cryptographic digest of a binary file."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def validate_model_bundle(
    model_path: Path,
    metadata_path: Path,
    validation_dir: Path,
    extension_version: str,
    prepare_released_legacy: bool = False,
) -> None:
    validator = ROOT_DIR / "scripts" / "validate_extension_model_metadata.ts"
    result = subprocess.run(
        [
            "pnpm",
            "--filter",
            "@phishguard/extension",
            "exec",
            "tsx",
            str(validator),
            str(model_path),
            str(metadata_path),
            str(validation_dir),
            extension_version,
            *(["--prepare-released-legacy"] if prepare_released_legacy else []),
        ],
        cwd=str(ROOT_DIR),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Student model metadata validation failed")


def _is_release_version(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split(".")
    return len(parts) == 3 and all(
        part.isdigit() and (part == "0" or not part.startswith("0"))
        for part in parts
    )


def _require_unused_versioned_archives(downloads_dir: Path, version: str) -> None:
    versioned_paths = [
        downloads_dir / f"phishguard-extension-v{version}.zip",
        downloads_dir / f"phishguard-extension-webstore-v{version}.zip",
        downloads_dir / f"phishguard-extension-v{version}.crx",
    ]
    existing = [path for path in versioned_paths if path.exists()]
    if existing:
        raise FileExistsError(f"Versioned extension archive already exists: {existing[0]}")


def ensure_extension_built(force_rebuild: bool = False):
    """Verifies that extension bundles exist and are fresh, or invokes the build tool with auto-bump."""
    dist_dir = EXTENSION_DIR / "dist"
    required_files = [
        dist_dir / "background.js",
        dist_dir / "content.js",
        dist_dir / "popup.js",
        dist_dir / "options.js",
    ]
    all_exist = all(f.exists() for f in required_files)

    is_stale = False
    if all_exist:
        dist_mtime = min(f.stat().st_mtime for f in required_files)
        src_dirs = [EXTENSION_DIR / "src", EXTENSION_DIR / "popup", EXTENSION_DIR / "options"]
        for s_dir in src_dirs:
            if s_dir.exists():
                for s_file in s_dir.rglob("*"):
                    if s_file.is_file() and s_file.suffix in (".ts", ".js", ".html", ".css"):
                        if s_file.stat().st_mtime > dist_mtime:
                            is_stale = True
                            break
                if is_stale:
                    break

    if not all_exist or is_stale or force_rebuild or os.environ.get("REBUILD_EXTENSION", "").lower() in ("1", "true"):
        reason = "missing" if not all_exist else ("stale" if is_stale else "requested")
        print(f"[PhishGuard Packager] Extension bundles are {reason}. Running build (with auto-version bump)...")
        cmd = ["pnpm", "--filter", "@phishguard/extension", "build"]
        env = os.environ.copy()
        local_app_data = env.get("LOCALAPPDATA", "")
        if local_app_data:
            node_path = Path(local_app_data) / "Programs" / "nodejs"
            if node_path.exists():
                env["PATH"] = f"{node_path};{env.get('PATH', '')}"
        res = subprocess.run(cmd, cwd=str(ROOT_DIR), env=env, shell=(sys.platform == "win32"))
        if res.returncode != 0:
            raise RuntimeError("Failed to build @phishguard/extension")


def _decode_key_material(raw: bytes) -> bytes:
    """Accepts a raw PEM or a base64-encoded PEM and returns PEM bytes."""
    text = raw.strip()
    if b"-----BEGIN" in text:
        return text + b"\n"
    try:
        decoded = base64.b64decode(b"".join(text.split()), validate=True)
    except Exception as e:
        raise RuntimeError(f"Extension signing key is neither a PEM nor valid base64: {e}") from e
    if b"-----BEGIN" not in decoded:
        raise RuntimeError("Extension signing key base64 did not decode to a PEM private key.")
    return decoded.strip() + b"\n"


def load_signing_key() -> bytes:
    """Loads the persistent RSA signing key (PEM bytes) that fixes the extension ID.

    Order: EXTENSION_SIGNING_KEY_FILE, EXTENSION_SIGNING_KEY_B64, local PEM_KEY_PATH.
    Never generates a key.
    """
    key_file = os.environ.get("EXTENSION_SIGNING_KEY_FILE", "").strip()
    if key_file:
        path = Path(key_file)
        if not path.is_file():
            raise RuntimeError(f"EXTENSION_SIGNING_KEY_FILE does not exist: {key_file}")
        return _decode_key_material(path.read_bytes())

    key_b64 = os.environ.get("EXTENSION_SIGNING_KEY_B64", "").strip()
    if key_b64:
        return _decode_key_material(key_b64.encode("utf-8"))

    if PEM_KEY_PATH.is_file():
        return _decode_key_material(PEM_KEY_PATH.read_bytes())

    raise RuntimeError(
        "No extension signing key found. A new key would change the extension ID and break "
        "updates, so one is never auto-generated. Provide the existing key via "
        "EXTENSION_SIGNING_KEY_FILE (path to PEM or base64 PEM), EXTENSION_SIGNING_KEY_B64 "
        f"(base64 of the PEM, e.g. `base64 -w0 phishguard-extension.pem`), or place it at {PEM_KEY_PATH}."
    )


def _extension_id_from_public_der(der: bytes) -> str:
    sha = hashlib.sha256(der).hexdigest()[:32]
    # Chrome extension ID maps hex digits 0-f to chars a-p
    return "".join(chr(ord("a") + int(c, 16)) for c in sha)


def derive_extension_id(pem_bytes: bytes) -> str:
    """Derives deterministic 32-char Chromium extension ID from the RSA public key."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    key = load_pem_private_key(pem_bytes, password=None)
    der = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return _extension_id_from_public_der(der)


def derive_extension_id_from_manifest_key(manifest_key: str) -> str:
    """Derives the extension ID Chrome assigns for a manifest `key` (base64 SPKI DER)."""
    return _extension_id_from_public_der(base64.b64decode(manifest_key))


def assert_key_matches_manifest(pem_bytes: bytes, manifest: dict) -> str:
    """Fails if the signing key's ID differs from the manifest `key` ID; returns the ID."""
    key_id = derive_extension_id(pem_bytes)
    manifest_key = manifest.get("key")
    if not manifest_key:
        raise RuntimeError("manifest.json has no `key`; the extension ID would not be stable.")
    manifest_id = derive_extension_id_from_manifest_key(manifest_key)
    if key_id != manifest_id:
        raise RuntimeError(
            f"Signing key produces extension ID {key_id} but manifest `key` produces {manifest_id}. "
            "Wrong EXTENSION_SIGNING_KEY secret; refusing to build an orphaned CRX."
        )
    return key_id


def normalize_url(raw: str | None) -> str | None:
    """Normalizes domain or URL string to absolute http(s) URL without trailing slash."""
    if not raw:
        return None
    val = raw.strip().rstrip("/")
    if not val:
        return None
    if not val.startswith(("http://", "https://")):
        import re
        if re.match(r"^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$", val, re.IGNORECASE):
            val = f"http://{val}"
        else:
            val = f"https://{val}"
    return val.rstrip("/")


def get_update_base_url() -> str | None:
    """Returns normalized BACKEND_URL, GATEWAY_DOMAIN or EXTENSION_UPDATE_BASE_URL."""
    candidate = (
        os.environ.get("BACKEND_URL", "").strip()
        or os.environ.get("GATEWAY_DOMAIN", "").strip()
        or os.environ.get("EXTENSION_UPDATE_BASE_URL", "").strip()
    )
    return normalize_url(candidate)


def apply_update_url(manifest: dict, base_url: str | None) -> dict:
    """Returns a copy of the manifest with update_url set; the input is not mutated."""
    staged = dict(manifest)
    if base_url:
        staged["update_url"] = f"{base_url.rstrip('/')}/download/updates.xml"
    else:
        print(
            "[PhishGuard Packager] Warning: BACKEND_URL is not set; "
            "update_url is omitted and Chrome will not auto-update this build."
        )
    return staged


def make_webstore_manifest(manifest: dict) -> dict:
    """Returns a copy of the manifest without `key` and `update_url` (Web Store assigns both)."""
    return {k: v for k, v in manifest.items() if k not in ("key", "update_url")}


def find_chromium_browser() -> str | None:
    """Finds installed Chromium-based browser for headless CRX packing."""
    candidates = [
        "brave-browser",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ]
    for name in candidates:
        path = shutil.which(name)
        if path:
            return path
    return None


def pack_crx_pure_python(zip_path: Path, pem_bytes: bytes, output_crx: Path) -> bool:
    """Builds a standards-compliant Chromium CRX3 package without requiring an external browser."""
    try:
        import struct
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        key = load_pem_private_key(pem_bytes, password=None)

        pub_der = key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        crx_id = hashlib.sha256(pub_der).digest()[:16]

        # SignedData protobuf: field 1 (crx_id), tag = 0x0a, length = 16 bytes
        signed_header_data = b"\x0a\x10" + crx_id

        with open(zip_path, "rb") as f:
            zip_bytes = f.read()

        # Chromium CRX3 signing format
        data_to_sign = (
            b"CRX3 SignedData\x00"
            + struct.pack("<I", len(signed_header_data))
            + signed_header_data
            + zip_bytes
        )
        sig = key.sign(
            data_to_sign,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
            hashes.SHA256(),
        )

        def encode_varint(val: int) -> bytes:
            res = bytearray()
            while val > 0x7F:
                res.append((val & 0x7F) | 0x80)
                val >>= 7
            res.append(val & 0x7F)
            return bytes(res)

        # AsymmetricKeyProof: field 1 (public_key) + field 2 (signature)
        proof = (
            b"\x0a"
            + encode_varint(len(pub_der))
            + pub_der
            + b"\x12"
            + encode_varint(len(sig))
            + sig
        )

        # CrxFileHeader: field 2 (sha256_with_rsa) + field 10000 (signed_header_data)
        header_bytes = (
            b"\x12"
            + encode_varint(len(proof))
            + proof
            + bytes([0x82, 0xF1, 0x04])
            + encode_varint(len(signed_header_data))
            + signed_header_data
        )

        # Full CRX3: Magic ('Cr24') + Version 3 (uint32_le) + Header size (uint32_le) + Header + Zip
        crx_bytes = (
            b"Cr24"
            + struct.pack("<I", 3)
            + struct.pack("<I", len(header_bytes))
            + header_bytes
            + zip_bytes
        )

        with open(output_crx, "wb") as f:
            f.write(crx_bytes)
        print(f"[PhishGuard Packager] Built signed CRX3 package ({format_file_size(len(crx_bytes))}) via pure-Python engine.")
        return True
    except Exception as e:
        print(f"[PhishGuard Packager] Pure-Python CRX3 packaging failed: {e}")
        return False


def pack_crx(staging_dir: Path, pem_bytes: bytes, output_crx: Path, zip_path: Path | None = None) -> bool:
    """Packages a cryptographically signed .crx package (pure-Python first, browser fallback)."""
    if zip_path and zip_path.exists():
        if pack_crx_pure_python(zip_path, pem_bytes, output_crx):
            return True

    browser_bin = find_chromium_browser()
    if not browser_bin:
        print("[PhishGuard Packager] Warning: No Chromium browser executable found. Skipping .crx build.")
        return False

    fd, tmp_key_name = tempfile.mkstemp(suffix=".pem")
    try:
        with os.fdopen(fd, "wb") as tmp_key:
            tmp_key.write(pem_bytes)
        cmd = [
            browser_bin,
            "--headless",
            f"--pack-extension={staging_dir}",
            f"--pack-extension-key={tmp_key_name}",
        ]
        print(f"[PhishGuard Packager] Packaging CRX with {Path(browser_bin).name}...")
        res = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        os.unlink(tmp_key_name)
    if res.returncode != 0:
        print(f"[PhishGuard Packager] Warning: CRX build failed with code {res.returncode}: {res.stderr}")
        return False

    expected_crx = staging_dir.parent / f"{staging_dir.name}.crx"
    if expected_crx.exists():
        shutil.move(expected_crx, output_crx)
        return True
    return False


def generate_updates_xml(extension_id: str, version: str, base_url: str | None, dest_path: Path) -> str:
    """Generates Chromium autoupdate protocol 2.0 XML; returns the codebase URL used.

    The codebase is absolute and version-pinned when base_url is set (Chrome requires an
    absolute URL, and the versioned path avoids CRX/XML cache skew).
    """
    if base_url:
        codebase_url = f"{base_url.rstrip('/')}/download/phishguard-extension-v{version}.crx"
    else:
        print(
            "[PhishGuard Packager] Warning: BACKEND_URL is not set; "
            "updates.xml codebase is relative and will not work for Chrome auto-update."
        )
        codebase_url = "/download/phishguard-extension.crx"
    xml_content = f"""<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='{extension_id}'>
    <updatecheck codebase='{codebase_url}' version='{version}' />
  </app>
</gupdate>
"""
    with open(dest_path, "w", encoding="utf-8") as f:
        f.write(xml_content.strip() + "\n")
    return codebase_url


def write_zip(staging_dir: Path, dest: Path, manifest_override: dict | None = None) -> None:
    """Zips the staging directory, optionally substituting manifest.json contents."""
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(staging_dir):
            for file in files:
                abs_path = Path(root) / file
                rel_path = abs_path.relative_to(staging_dir)
                arcname = str(rel_path).replace("\\", "/")
                if manifest_override is not None and arcname == "manifest.json":
                    zf.writestr(arcname, json.dumps(manifest_override, indent=2) + "\n")
                else:
                    zf.write(abs_path, arcname=arcname)


def package_extension(
    force_rebuild: bool = False,
    local_only: bool = False,
    *,
    require_backend_url: bool = False,
    extension_dir: Path | None = None,
    downloads_dir: Path | None = None,
    staging_parent: Path | None = None,
    backend_models_dir: Path | None = None,
):
    """Assembles all extension assets, compresses into a zip & crx, and generates metadata."""
    ensure_extension_built(force_rebuild=force_rebuild)
    extension_dir = Path(extension_dir or EXTENSION_DIR)
    downloads_dir = Path(downloads_dir or BACKEND_STATIC_DOWNLOADS)
    staging_parent = Path(staging_parent or BUILD_DIR)
    backend_models_dir = Path(backend_models_dir or ROOT_DIR / "apps" / "backend" / "models")

    # Read extension version from manifest.json
    manifest_path = extension_dir / "manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    version = manifest_data.get("version", "0.1.0")
    models_src = extension_dir / "public" / "models"
    model_path = models_src / "student_model.onnx"
    metadata_path = models_src / "student_model.metadata.json"
    if not model_path.is_file():
        raise FileNotFoundError(f"Student model missing at {model_path}")
    if not metadata_path.is_file():
        try:
            validate_model_bundle(
                model_path, metadata_path, backend_models_dir, version,
                prepare_released_legacy=True,
            )
        except RuntimeError as exc:
            raise FileNotFoundError(f"Student model metadata missing at {metadata_path}") from exc
    try:
        model_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Student model metadata is unreadable") from exc
    model_version = model_metadata.get("version") if isinstance(model_metadata, dict) else None
    if not _is_release_version(model_version):
        raise RuntimeError("Student model metadata version is invalid")
    validation_dir = backend_models_dir / f"v{model_version}"
    validate_model_bundle(model_path, metadata_path, validation_dir, version)

    downloads_dir.mkdir(parents=True, exist_ok=True)
    _require_unused_versioned_archives(downloads_dir, version)

    pem_bytes = load_signing_key()
    extension_id = assert_key_matches_manifest(pem_bytes, manifest_data)
    base_url = get_update_base_url()
    if require_backend_url and not base_url:
        raise RuntimeError(
            "BACKEND_URL/GATEWAY_DOMAIN is unset; refusing to package an extension that would "
            "default to http://localhost:8000. Pass BACKEND_URL=<gateway URL> (or GATEWAY_DOMAIN)."
        )
    staged_manifest = apply_update_url(manifest_data, base_url)

    print(f"[PhishGuard Packager] Packaging PhishGuard Extension v{version} (ID: {extension_id})...")

    # Prepare staging directory
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_owner = tempfile.TemporaryDirectory(prefix="phishguard-extension-", dir=str(staging_parent))
    stage_dir = Path(staging_owner.name)

    # 1. Write staged manifest.json (source manifest is never modified)
    with open(stage_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(staged_manifest, f, indent=2)
        f.write("\n")

    # 2. Copy dist/
    shutil.copytree(extension_dir / "dist", stage_dir / "dist")

    # 3. Copy popup/
    (stage_dir / "popup").mkdir(exist_ok=True)
    shutil.copy2(extension_dir / "popup" / "popup.html", stage_dir / "popup" / "popup.html")

    # 4. Copy options/
    options_src = extension_dir / "options" / "options.html"
    if options_src.exists():
        (stage_dir / "options").mkdir(exist_ok=True)
        shutil.copy2(options_src, stage_dir / "options" / "options.html")

    # 5. Ship extension with latest model version & WASM assets
    # Ensure top-level assets/ and models/ are available alongside dist/
    assets_src = extension_dir / "public" / "assets"
    # CPU-only WASM runtime binaries; the JSEP worker wasm is never packaged.
    cpu_wasm_assets = ("ort-wasm-simd-threaded.wasm", "sql-wasm.wasm")
    if assets_src.exists():
        assets_target = stage_dir / "assets"
        assets_target.mkdir(exist_ok=True)
        for asset_name in cpu_wasm_assets:
            asset = assets_src / asset_name
            if asset.is_file():
                shutil.copy2(asset, assets_target / asset_name)
    # A stale dist build may still carry JSEP or hashed wasm copies under
    # dist/assets; keep only the CPU binaries there as well.
    staged_dist_assets = stage_dir / "dist" / "assets"
    if staged_dist_assets.is_dir():
        for stale in staged_dist_assets.iterdir():
            if stale.is_file() and stale.suffix == ".wasm" and stale.name not in cpu_wasm_assets:
                stale.unlink()

    models_target = stage_dir / "models"
    models_target.mkdir(exist_ok=True)
    dist_models_target = stage_dir / "dist" / "models"
    dist_models_target.mkdir(exist_ok=True)
    for target in (models_target, dist_models_target):
        shutil.copy2(model_path, target / model_path.name)
        shutil.copy2(metadata_path, target / metadata_path.name)

    # 6. Copy icons/
    icons_target = stage_dir / "icons"
    icons_target.mkdir(exist_ok=True)
    icons_src = extension_dir / "public" / "icons"
    if icons_src.exists():
        for icon in icons_src.glob("*.png"):
            shutil.copy2(icon, icons_target / icon.name)

    # Prepare destination directory in backend static
    # 7. Build unpacked-install ZIP (keeps `key` + `update_url`) and Web Store ZIP
    zip_filename = "phishguard-extension.zip"
    versioned_filename = f"phishguard-extension-v{version}.zip"
    zip_dest = downloads_dir / zip_filename
    versioned_dest = downloads_dir / versioned_filename

    print(f"[PhishGuard Packager] Creating ZIP archive {zip_dest}...")
    write_zip(stage_dir, zip_dest)
    shutil.copy2(zip_dest, versioned_dest)
    zip_sha256 = compute_sha256(zip_dest)
    zip_size = zip_dest.stat().st_size
    zip_size_formatted = format_file_size(zip_size)

    webstore_filename = "phishguard-extension-webstore.zip"
    webstore_dest = downloads_dir / webstore_filename
    webstore_versioned_dest = downloads_dir / f"phishguard-extension-webstore-v{version}.zip"
    print(f"[PhishGuard Packager] Creating Chrome Web Store ZIP archive {webstore_dest}...")
    write_zip(stage_dir, webstore_dest, manifest_override=make_webstore_manifest(manifest_data))
    shutil.copy2(webstore_dest, webstore_versioned_dest)

    # 8. Build signed CRX package
    crx_filename = "phishguard-extension.crx"
    crx_dest = downloads_dir / crx_filename
    crx_built = pack_crx(stage_dir, pem_bytes, crx_dest, zip_path=zip_dest)
    crx_sha256 = compute_sha256(crx_dest) if crx_built and crx_dest.exists() else None
    crx_size = crx_dest.stat().st_size if crx_built and crx_dest.exists() else 0
    crx_size_formatted = format_file_size(crx_size) if crx_built else None

    # 9. Generate Chromium updates.xml manifest
    updates_xml_path = downloads_dir / "updates.xml"
    generate_updates_xml(
        extension_id=extension_id,
        version=version,
        base_url=base_url,
        dest_path=updates_xml_path,
    )
    updates_url = f"{base_url}/download/updates.xml" if base_url else "/download/updates.xml"

    # 10. Generate extension-meta.json
    metadata = {
        "name": "PhishGuard Browser Extension",
        "version": version,
        "extension_id": extension_id,
        "filename": zip_filename,
        "versioned_filename": versioned_filename,
        "download_url": "/download/extension",
        "crx_filename": crx_filename if crx_built else None,
        "crx_download_url": "/download/phishguard-extension.crx" if crx_built else None,
        "webstore_filename": webstore_filename,
        "webstore_download_url": f"/download/{webstore_filename}",
        "updates_url": updates_url,
        "sha256": zip_sha256,
        "size_bytes": zip_size,
        "size_formatted": zip_size_formatted,
        "crx_sha256": crx_sha256,
        "crx_size_bytes": crx_size,
        "crx_size_formatted": crx_size_formatted,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "manifest_version": manifest_data.get("manifest_version", 3),
        "supported_browsers": [
            "Google Chrome (113+)",
            "Brave Browser",
            "Microsoft Edge",
            "Opera / Chromium MV3",
        ],
        "distribution_channels": [
            {
                "channel": "chrome_web_store",
                "label": "Chrome Web Store (ZIP package)",
                "url": f"/download/{webstore_filename}",
                "format": "zip",
            },
            {
                "channel": "unpacked_zip",
                "label": "Unpacked ZIP (Load unpacked)",
                "url": "/download/extension",
                "format": "zip",
            },
            {
                "channel": "direct_crx",
                "label": "Direct Chromium Package (Signed .CRX)",
                "url": "/download/phishguard-extension.crx",
                "format": "crx",
            },
        ],
    }

    # Also copy versioned CRX package
    if crx_built and crx_dest.exists():
        versioned_crx_dest = downloads_dir / f"phishguard-extension-v{version}.crx"
        shutil.copy2(crx_dest, versioned_crx_dest)
        metadata["versioned_crx_filename"] = f"phishguard-extension-v{version}.crx"

    # Keep the disk fallback metadata aligned with the packages it serves.
    with open(downloads_dir / "extension-meta.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    # Write latest.json metadata for direct build version lookups
    latest_file = downloads_dir / "latest.json"
    latest_meta = {
        "version": version,
        "name": "PhishGuard Browser Extension",
        "built_at": metadata["built_at"],
        "sha256": zip_sha256,
        "crx_sha256": crx_sha256,
        "extension_id": extension_id,
        "filename": zip_filename,
        "versioned_filename": versioned_filename,
        "crx_filename": crx_filename if crx_built else None,
        "versioned_crx_filename": f"phishguard-extension-v{version}.crx" if crx_built else None,
        "download_url": "/download/extension",
        "crx_download_url": "/download/phishguard-extension.crx" if crx_built else None,
        "webstore_filename": webstore_filename,
        "webstore_download_url": f"/download/{webstore_filename}",
        "updates_url": updates_url,
        "size_bytes": zip_size,
        "crx_size_bytes": crx_size,
    }
    with open(latest_file, "w", encoding="utf-8") as f:
        json.dump(latest_meta, f, indent=2)

    # Cleanup staging directory
    staging_owner.cleanup()

    # 11. Store extension build artifacts in the RustFS S3 bucket
    if not local_only:
        _store_artifacts_in_bucket(downloads_dir, version, latest_meta)

    return metadata


def _store_artifacts_in_bucket(downloads_dir: Path, version: str, meta: dict):
    """Uploads built extension artifacts to the RustFS S3 bucket."""
    endpoint = os.environ.get("RUSTFS_ENDPOINT_URL") or "http://rustfs:9000"
    bucket = os.environ.get("RUSTFS_BUCKET") or "phishguard-artifacts"
    access_key = os.environ.get("RUSTFS_ACCESS_KEY", "rustfsadmin")
    secret_key = os.environ.get("RUSTFS_SECRET_KEY", "rustfsadmin")
    region = os.environ.get("RUSTFS_REGION", "us-east-1")

    # 1. Try phishguard_backend storage service if available
    try:
        import asyncio
        from phishguard_backend.services.storage import RustFSArtifactStorageService
        models_dir = Path(__file__).resolve().parent.parent / "apps" / "backend" / "models"
        target_buckets = {bucket, "phishguard-artifacts", "phishguard-artifacts-dev-1"}
        total_synced = 0
        for tgt_bucket in target_buckets:
            service = RustFSArtifactStorageService(
                endpoint_url=endpoint if ("localhost" in endpoint or "127.0.0.1" in endpoint) else (
                    "http://localhost:9000" if "rustfs:9000" in endpoint else endpoint
                ),
                access_key=access_key,
                secret_key=secret_key,
                bucket=tgt_bucket,
                region=region,
            )
            if not asyncio.run(service.is_healthy()):
                alt = "http://rustfs:9000" if "localhost" in service.endpoint_url else "http://localhost:9000"
                service.endpoint_url = alt
                if not asyncio.run(service.is_healthy()):
                    continue
            asyncio.run(service.ensure_bucket())
            res = asyncio.run(service.sync_local_artifacts(downloads_dir, models_dir=models_dir))
            total_synced += len(res.get("synced", []))

            # Also mirror model version aliases in the bucket
            if models_dir.exists():
                for m_ver_dir in models_dir.iterdir():
                    if m_ver_dir.is_dir():
                        m_file = m_ver_dir / "student_model.onnx"
                        if m_file.exists():
                            ver_str = m_ver_dir.name.lstrip("v")
                            asyncio.run(service.upload_file(f"models/{ver_str}/student_model.onnx", m_file))
                            asyncio.run(service.upload_file(f"models/student_model_{ver_str}.onnx", m_file))
                            asyncio.run(service.upload_file(f"student_model_{ver_str}.onnx", m_file))

            # Also store versioned directory prefix in the bucket
            for item in downloads_dir.iterdir():
                if item.is_file():
                    asyncio.run(service.upload_file(f"extension/versions/{version}/{item.name}", item))

            # Ensure latest.json is directly stored at root and extension/
            latest_path = downloads_dir / "latest.json"
            if latest_path.exists():
                asyncio.run(service.upload_file("extension/latest.json", latest_path, content_type="application/json"))
                asyncio.run(service.upload_file("latest.json", latest_path, content_type="application/json"))

        print(f"[PhishGuard Packager] Successfully stored build v{version} and models in RustFS buckets ({', '.join(sorted(target_buckets))}). Total synced: {total_synced} artifacts.")
        return
    except Exception as e:
        print(f"[PhishGuard Packager] Backend storage service unavailable ({e}); attempting direct HTTP upload...")

    # 2. Direct HTTP / S3 SigV4 fallback upload (zero external dependency)
    try:
        import urllib.request
        from urllib.parse import urlparse

        endpoint = endpoint.rstrip("/")

        def _sign_and_put(key: str, data: bytes, content_type: str = "application/octet-stream"):
            url = f"{endpoint}/{bucket}/{key.lstrip('/')}"
            parsed = urlparse(url)
            host = parsed.netloc
            path = parsed.path

            now = datetime.now(timezone.utc)
            amz_date = now.strftime("%Y%m%dT%H%M%SZ")
            date_stamp = now.strftime("%Y%m%d")
            payload_hash = hashlib.sha256(data).hexdigest()

            headers = {
                "Host": host,
                "Content-Type": content_type,
                "x-amz-date": amz_date,
                "x-amz-content-sha256": payload_hash,
            }

            if access_key and secret_key:
                sorted_keys = sorted(k.lower() for k in headers.keys())
                canonical_headers = "".join(f"{k}:{headers[k if k != 'host' else 'Host'].strip()}\n" for k in sorted_keys)
                signed_headers = ";".join(sorted_keys)
                canonical_request = f"PUT\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
                credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
                string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"

                import hmac
                def _sign(k_bytes, msg):
                    return hmac.new(k_bytes, msg.encode("utf-8"), hashlib.sha256).digest()

                k_date = _sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
                k_region = _sign(k_date, region)
                k_service = _sign(k_region, "s3")
                k_signing = _sign(k_service, "aws4_request")
                sig = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
                headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={sig}"

            req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status in (200, 201, 204)

        # Upload bucket files
        for f in downloads_dir.iterdir():
            if f.is_file():
                data = f.read_bytes()
                c_type = "application/zip" if f.suffix == ".zip" else ("application/json" if f.suffix == ".json" else "application/octet-stream")
                _sign_and_put(f"extension/{f.name}", data, c_type)
                _sign_and_put(f"extension/versions/{version}/{f.name}", data, c_type)
                _sign_and_put(f.name, data, c_type)
        print(f"[PhishGuard Packager] Direct HTTP upload of build v{version} to {endpoint}/{bucket} complete.")
    except Exception as e:
        print(f"[PhishGuard Packager] RustFS bucket storage skipped or unreachable ({e}). Local artifacts retained on disk.")


if __name__ == "__main__":
    force = "--rebuild" in sys.argv or "--force" in sys.argv
    package_extension(
        force_rebuild=force,
        local_only="--local-only" in sys.argv,
        require_backend_url="--require-backend-url" in sys.argv,
    )

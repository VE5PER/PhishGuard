#!/usr/bin/env python3
"""Manage the PhishGuard extension signing key.

The CRX signing key fixes the extension ID (loanjnnlfhechkonbjelmbdacmmcbagg). Generating a new key
changes the ID and breaks updates for every existing install, so the default workflow reuses the
existing key. This tool never prints the private key.

  status       show where the key was found and whether it matches apps/extension/manifest.json
  generate     create a NEW key (changes the extension ID; refuses to overwrite without --force)
  export-env   upsert EXTENSION_SIGNING_KEY_B64 into an env file (used by docker build secrets)
"""

import argparse
import base64
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import package_extension as pe  # noqa: E402

ENV_VAR = "EXTENSION_SIGNING_KEY_B64"
DEFAULT_ENV_FILE = pe.ROOT_DIR / ".env"
EXCLUDED_DIRS = {"node_modules", "dist", "out", ".venv", ".git", "__pycache__", ".next", "build", ".pnpm-store"}
MAX_SCAN_BYTES = 2 * 1024 * 1024


def manifest_path() -> Path:
    return pe.EXTENSION_DIR / "manifest.json"


def read_manifest_key() -> Optional[str]:
    match = re.search(r'"key"\s*:\s*"([^"]*)"', manifest_path().read_text(encoding="utf-8"))
    return match.group(1) if match else None


def find_key_source() -> Optional[Tuple[str, str]]:
    """Mirrors package_extension.load_signing_key's lookup order and reports where the key comes from."""
    key_file = os.environ.get("EXTENSION_SIGNING_KEY_FILE", "").strip()
    if key_file:
        return "EXTENSION_SIGNING_KEY_FILE", key_file
    if os.environ.get(ENV_VAR, "").strip():
        return ENV_VAR, "environment variable"
    if pe.PEM_KEY_PATH.is_file():
        return "default path", str(pe.PEM_KEY_PATH)
    return None


def key_history_commits() -> List[str]:
    try:
        result = subprocess.run(
            ["git", "log", "--all", "--format=%h", "--", str(pe.PEM_KEY_PATH.relative_to(pe.ROOT_DIR))],
            cwd=str(pe.ROOT_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, ValueError):
        return []
    return [line for line in result.stdout.split() if line] if result.returncode == 0 else []


def find_files_containing(needle: str) -> List[Path]:
    hits: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(pe.ROOT_DIR):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        if Path(dirpath).parts[-3:] == ("backend", "static", "downloads"):
            dirnames[:] = []
            continue
        for name in filenames:
            path = Path(dirpath) / name
            try:
                if path.stat().st_size > MAX_SCAN_BYTES:
                    continue
                if needle in path.read_text(encoding="utf-8"):
                    hits.append(path)
            except (OSError, UnicodeDecodeError):
                continue
    return sorted(hits)


def cmd_status(_args: argparse.Namespace) -> int:
    source = find_key_source()
    if source is None:
        print("No signing key found.")
        print(f"  Place the existing key at {pe.PEM_KEY_PATH}, or set EXTENSION_SIGNING_KEY_FILE / {ENV_VAR}.")
        print("  Run `scripts/extension_key.py generate` only if you accept a NEW extension ID.")
        return 2

    try:
        pem = pe.load_signing_key()
        key_id = pe.derive_extension_id(pem)
    except Exception as exc:
        print(f"Signing key found via {source[0]} ({source[1]}) but could not be loaded: {exc}")
        return 2

    manifest_key = read_manifest_key()
    manifest_id = pe.derive_extension_id_from_manifest_key(manifest_key) if manifest_key else None

    print(f"Key source:        {source[0]} ({source[1]})")
    print(f"Key extension ID:  {key_id}")
    print(f"Manifest key ID:   {manifest_id or '(manifest has no key)'}")

    commits = key_history_commits()
    if commits:
        print(
            f"WARNING: {pe.PEM_KEY_PATH.relative_to(pe.ROOT_DIR)} appears in git history "
            f"({', '.join(commits)}). Treat the key as exposed and plan a deliberate rotation."
        )

    if manifest_id == key_id:
        print("Result: MATCH")
        return 0
    print("Result: MISMATCH (packaging would fail; the key does not belong to this manifest)")
    return 1


def generate_private_key_pem() -> bytes:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def public_key_b64(pem: bytes) -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    der = load_pem_private_key(pem, password=None).public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return base64.b64encode(der).decode("ascii")


def write_private_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    os.chmod(path, 0o600)


def update_manifest_key(new_key_b64: str) -> None:
    path = manifest_path()
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(r'("key"\s*:\s*")[^"]*(")', lambda m: f"{m.group(1)}{new_key_b64}{m.group(2)}", text, count=1)
    if count != 1:
        raise RuntimeError("manifest.json has no \"key\" field to update.")
    path.write_text(updated, encoding="utf-8")


def cmd_generate(args: argparse.Namespace) -> int:
    if pe.PEM_KEY_PATH.exists() and not args.force:
        print(f"A signing key already exists at {pe.PEM_KEY_PATH}. Refusing to overwrite it.")
        print("Re-run with --force only if you accept a new extension ID (existing installs stop updating).")
        return 1

    old_key = read_manifest_key()
    old_id = pe.derive_extension_id_from_manifest_key(old_key) if old_key else None

    pem = generate_private_key_pem()
    write_private_file(pe.PEM_KEY_PATH, pem)
    new_id = pe.derive_extension_id(pem)
    print(f"Wrote new signing key to {pe.PEM_KEY_PATH} (mode 0600).")

    if not args.no_update_manifest:
        update_manifest_key(public_key_b64(pem))
        print(f"Updated the \"key\" in {manifest_path().relative_to(pe.ROOT_DIR)}.")
    else:
        print("Manifest NOT updated (--no-update-manifest); packaging will fail until the manifest key matches.")

    print(f"New extension ID: {new_id}")
    print("WARNING: the extension ID changed. Existing installs will NOT receive updates from this build,")
    print("         and any policy / update_url entries that reference the old ID must be updated.")
    if old_id and old_id != new_id:
        hits = find_files_containing(old_id)
        if hits:
            print(f"Files that still contain the old ID ({old_id}):")
            for hit in hits:
                print(f"  {hit.relative_to(pe.ROOT_DIR)}")
    return 0


def upsert_env_value(env_path: Path, name: str, value: str) -> None:
    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    pattern = re.compile(rf"^{re.escape(name)}=.*$", re.MULTILINE)
    line = f"{name}={value}"
    if pattern.search(existing):
        seen = False

        def replace(_match: "re.Match[str]") -> str:
            nonlocal seen
            if seen:
                return "\0"
            seen = True
            return line

        updated = pattern.sub(replace, existing)
        updated = re.sub(r"\0\n?", "", updated)
    else:
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        updated = f"{existing}{prefix}{line}\n"

    if not env_path.exists():
        env_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(updated)
    else:
        env_path.write_text(updated, encoding="utf-8")


def cmd_export_env(args: argparse.Namespace) -> int:
    try:
        pem = pe.load_signing_key()
        key_id = pe.derive_extension_id(pem)
    except Exception as exc:
        print(f"Cannot export: {exc}", file=sys.stderr)
        return 2

    encoded = base64.b64encode(pem).decode("ascii")
    if args.print:
        sys.stdout.write(encoded)
        sys.stdout.write("\n")
        return 0

    env_path = Path(args.env_file)
    upsert_env_value(env_path, ENV_VAR, encoded)
    print(f"Updated {ENV_VAR} in {env_path}")
    print(f"Extension ID: {key_id}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="show key source, derived extension IDs and whether they match (default)")

    gen = sub.add_parser("generate", help="create a NEW signing key (changes the extension ID)")
    gen.add_argument("--force", action="store_true", help="overwrite an existing key")
    gen.add_argument("--no-update-manifest", action="store_true", help="do not rewrite the manifest \"key\"")

    export = sub.add_parser("export-env", help=f"upsert {ENV_VAR} into an env file")
    export.add_argument("--env-file", default=str(DEFAULT_ENV_FILE), help="target env file (default: ./.env)")
    export.add_argument("--print", action="store_true", help="print the base64 value to stdout instead of writing a file")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "status"
    handlers = {"status": cmd_status, "generate": cmd_generate, "export-env": cmd_export_env}
    return handlers[command](args)


if __name__ == "__main__":
    sys.exit(main())

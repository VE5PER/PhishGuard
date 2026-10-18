"""Tests for scripts/extension_key.py (all paths redirected to a temp tree; never touches the real key)."""

import base64
import json
import stat
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import extension_key as ek  # noqa: E402
import package_extension as pe  # noqa: E402


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    extension_dir = root / "apps" / "extension"
    extension_dir.mkdir(parents=True)
    pem_path = root / "deploy" / "extension" / "phishguard-extension.pem"

    original_pem = ek.generate_private_key_pem()
    manifest = (
        "{\n"
        '  "manifest_version": 3,\n'
        '  "name": "Test",\n'
        f'  "key": "{ek.public_key_b64(original_pem)}",\n'
        '  "version": "1.0.0"\n'
        "}\n"
    )
    (extension_dir / "manifest.json").write_text(manifest, encoding="utf-8")

    monkeypatch.setattr(pe, "ROOT_DIR", root)
    monkeypatch.setattr(pe, "EXTENSION_DIR", extension_dir)
    monkeypatch.setattr(pe, "PEM_KEY_PATH", pem_path)
    monkeypatch.setattr(ek, "DEFAULT_ENV_FILE", root / ".env")
    monkeypatch.delenv("EXTENSION_SIGNING_KEY_FILE", raising=False)
    monkeypatch.delenv("EXTENSION_SIGNING_KEY_B64", raising=False)
    return {"root": root, "pem_path": pem_path, "manifest": extension_dir / "manifest.json", "original_pem": original_pem}


def test_status_reports_no_key(sandbox, capsys):
    assert ek.main(["status"]) == 2
    assert "No signing key found" in capsys.readouterr().out


def test_status_match_and_mismatch(sandbox, capsys):
    sandbox["pem_path"].parent.mkdir(parents=True)
    sandbox["pem_path"].write_bytes(sandbox["original_pem"])
    assert ek.main([]) == 0
    out = capsys.readouterr().out
    assert "MATCH" in out and "MISMATCH" not in out

    sandbox["pem_path"].write_bytes(ek.generate_private_key_pem())
    assert ek.main(["status"]) == 1
    assert "MISMATCH" in capsys.readouterr().out


def test_generate_creates_key_with_private_mode_and_updates_manifest(sandbox, capsys):
    old_manifest = json.loads(sandbox["manifest"].read_text())
    assert ek.main(["generate"]) == 0
    out = capsys.readouterr().out

    pem = sandbox["pem_path"].read_bytes()
    assert b"BEGIN PRIVATE KEY" in pem
    assert stat.S_IMODE(sandbox["pem_path"].stat().st_mode) == 0o600
    assert "BEGIN" not in out and base64.b64encode(pem).decode() not in out

    new_manifest_text = sandbox["manifest"].read_text()
    new_manifest = json.loads(new_manifest_text)
    assert new_manifest["key"] != old_manifest["key"]
    assert {k: v for k, v in new_manifest.items() if k != "key"} == {k: v for k, v in old_manifest.items() if k != "key"}
    assert new_manifest_text.startswith('{\n  "manifest_version": 3,')
    assert pe.derive_extension_id(pem) == pe.derive_extension_id_from_manifest_key(new_manifest["key"])
    assert "existing installs will not receive updates" in out.lower()


def test_generate_refuses_when_key_exists_and_force_overwrites(sandbox, capsys):
    sandbox["pem_path"].parent.mkdir(parents=True)
    sandbox["pem_path"].write_bytes(sandbox["original_pem"])
    manifest_before = sandbox["manifest"].read_text()

    assert ek.main(["generate"]) == 1
    assert sandbox["pem_path"].read_bytes() == sandbox["original_pem"]
    assert sandbox["manifest"].read_text() == manifest_before

    assert ek.main(["generate", "--force"]) == 0
    assert sandbox["pem_path"].read_bytes() != sandbox["original_pem"]
    assert sandbox["manifest"].read_text() != manifest_before


def test_generate_no_update_manifest_leaves_manifest_alone(sandbox):
    manifest_before = sandbox["manifest"].read_text()
    assert ek.main(["generate", "--no-update-manifest"]) == 0
    assert sandbox["manifest"].read_text() == manifest_before


def test_generate_lists_files_containing_old_extension_id(sandbox, capsys):
    old_id = pe.derive_extension_id(sandbox["original_pem"])
    (sandbox["root"] / "docs.md").write_text(f"extension {old_id}\n", encoding="utf-8")
    ignored = sandbox["root"] / "node_modules" / "pkg"
    ignored.mkdir(parents=True)
    (ignored / "x.txt").write_text(old_id, encoding="utf-8")

    assert ek.main(["generate"]) == 0
    out = capsys.readouterr().out
    assert old_id in out and "docs.md" in out
    assert "node_modules" not in out


def test_export_env_upsert_is_idempotent_and_preserves_other_lines(sandbox, capsys):
    sandbox["pem_path"].parent.mkdir(parents=True)
    sandbox["pem_path"].write_bytes(sandbox["original_pem"])
    env_file = sandbox["root"] / ".env"
    env_file.write_text("A=1\nEXTENSION_SIGNING_KEY_B64=old\nB=2", encoding="utf-8")

    assert ek.main(["export-env", "--env-file", str(env_file)]) == 0
    first = env_file.read_text()
    assert ek.main(["export-env", "--env-file", str(env_file)]) == 0
    assert env_file.read_text() == first

    lines = first.splitlines()
    assert lines[0] == "A=1" and lines[-1] == "B=2"
    key_lines = [line for line in lines if line.startswith("EXTENSION_SIGNING_KEY_B64=")]
    assert len(key_lines) == 1
    assert base64.b64decode(key_lines[0].split("=", 1)[1]) == sandbox["original_pem"].strip() + b"\n"

    out = capsys.readouterr().out
    assert key_lines[0].split("=", 1)[1] not in out
    assert pe.derive_extension_id(sandbox["original_pem"]) in out


def test_export_env_creates_missing_file_with_private_mode_and_print_mode(sandbox, capsys):
    sandbox["pem_path"].parent.mkdir(parents=True)
    sandbox["pem_path"].write_bytes(sandbox["original_pem"])
    env_file = sandbox["root"] / "new.env"

    assert ek.main(["export-env", "--env-file", str(env_file)]) == 0
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    capsys.readouterr()

    assert ek.main(["export-env", "--print"]) == 0
    printed = capsys.readouterr().out.strip()
    assert base64.b64decode(printed).startswith(b"-----BEGIN")


def test_export_env_without_key_fails(sandbox):
    assert ek.main(["export-env", "--env-file", str(sandbox["root"] / ".env")]) == 2

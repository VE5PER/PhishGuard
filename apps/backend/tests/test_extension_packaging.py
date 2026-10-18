"""Unit tests for scripts/package_extension.py signing-key, update_url, and updates.xml helpers."""

import base64
import importlib.util
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "package_extension.py"
SOURCE_MANIFEST = Path(__file__).resolve().parents[3] / "apps" / "extension" / "manifest.json"


@pytest.fixture(scope="module")
def pkg():
    spec = importlib.util.spec_from_file_location("package_extension", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_pem() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _manifest_key_for(pem: bytes) -> str:
    key = serialization.load_pem_private_key(pem, password=None)
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return base64.b64encode(der).decode()


@pytest.fixture
def clean_env(monkeypatch, tmp_path, pkg):
    monkeypatch.delenv("EXTENSION_SIGNING_KEY_FILE", raising=False)
    monkeypatch.delenv("EXTENSION_SIGNING_KEY_B64", raising=False)
    monkeypatch.delenv("BACKEND_URL", raising=False)
    monkeypatch.delenv("GATEWAY_DOMAIN", raising=False)
    monkeypatch.delenv("EXTENSION_UPDATE_BASE_URL", raising=False)
    monkeypatch.setattr(pkg, "PEM_KEY_PATH", tmp_path / "missing.pem")
    return monkeypatch


def test_key_precedence_file_over_b64_over_local(pkg, clean_env, tmp_path):
    pem_file, pem_b64, pem_local = _make_pem(), _make_pem(), _make_pem()
    local_path = tmp_path / "local.pem"
    local_path.write_bytes(pem_local)
    key_file = tmp_path / "key.txt"
    key_file.write_bytes(pem_file)
    clean_env.setattr(pkg, "PEM_KEY_PATH", local_path)

    assert pkg.load_signing_key().strip() == pem_local.strip()

    clean_env.setenv("EXTENSION_SIGNING_KEY_B64", base64.b64encode(pem_b64).decode())
    assert pkg.load_signing_key().strip() == pem_b64.strip()

    clean_env.setenv("EXTENSION_SIGNING_KEY_FILE", str(key_file))
    assert pkg.load_signing_key().strip() == pem_file.strip()


def test_key_file_may_contain_base64_pem(pkg, clean_env, tmp_path):
    pem = _make_pem()
    key_file = tmp_path / "key.b64"
    key_file.write_text(base64.b64encode(pem).decode() + "\n")
    clean_env.setenv("EXTENSION_SIGNING_KEY_FILE", str(key_file))
    assert pkg.load_signing_key().strip() == pem.strip()


def test_missing_key_raises_and_never_generates(pkg, clean_env, tmp_path):
    with pytest.raises(RuntimeError, match="never auto-generated|No extension signing key"):
        pkg.load_signing_key()
    assert not (tmp_path / "missing.pem").exists()
    assert not hasattr(pkg, "ensure_signing_key")


def test_invalid_key_material_raises(pkg, clean_env):
    clean_env.setenv("EXTENSION_SIGNING_KEY_B64", base64.b64encode(b"not a pem").decode())
    with pytest.raises(RuntimeError):
        pkg.load_signing_key()


def test_assert_key_matches_manifest(pkg):
    pem = _make_pem()
    manifest = {"key": _manifest_key_for(pem)}
    assert pkg.assert_key_matches_manifest(pem, manifest) == pkg.derive_extension_id(pem)

    with pytest.raises(RuntimeError, match="Wrong EXTENSION_SIGNING_KEY"):
        pkg.assert_key_matches_manifest(_make_pem(), manifest)

    with pytest.raises(RuntimeError, match="no `key`"):
        pkg.assert_key_matches_manifest(pem, {})


def test_apply_update_url_with_base_url(pkg):
    manifest = {"name": "x", "key": "k"}
    staged = pkg.apply_update_url(manifest, "https://ext.example.com/")
    assert staged["update_url"] == "https://ext.example.com/download/updates.xml"
    assert "update_url" not in manifest


def test_apply_update_url_without_base_url_warns(pkg, capsys):
    manifest = {"name": "x"}
    staged = pkg.apply_update_url(manifest, None)
    assert "update_url" not in staged
    assert "Warning" in capsys.readouterr().out


def test_source_manifest_has_no_update_url():
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    assert "update_url" not in manifest


def test_make_webstore_manifest_drops_key_and_update_url(pkg):
    manifest = {"name": "x", "version": "0.3.0", "key": "k", "update_url": "https://e/download/updates.xml"}
    store = pkg.make_webstore_manifest(manifest)
    assert store == {"name": "x", "version": "0.3.0"}
    assert "key" in manifest and "update_url" in manifest


def test_generate_updates_xml_absolute_codebase(pkg, tmp_path):
    dest = tmp_path / "updates.xml"
    codebase = pkg.generate_updates_xml("a" * 32, "0.3.0", "https://ext.example.com/", dest)
    expected = "https://ext.example.com/download/phishguard-extension-v0.3.0.crx"
    assert codebase == expected
    xml = dest.read_text(encoding="utf-8")
    assert f"codebase='{expected}'" in xml
    assert "version='0.3.0'" in xml
    assert f"appid='{'a' * 32}'" in xml


def test_generate_updates_xml_relative_when_unset(pkg, tmp_path, capsys):
    dest = tmp_path / "updates.xml"
    codebase = pkg.generate_updates_xml("a" * 32, "0.3.0", None, dest)
    assert codebase == "/download/phishguard-extension.crx"
    assert "codebase='/download/phishguard-extension.crx'" in dest.read_text(encoding="utf-8")
    assert "Warning" in capsys.readouterr().out


def test_write_zip_manifest_override(pkg, tmp_path):
    import zipfile

    staging = tmp_path / "stage"
    staging.mkdir()
    (staging / "manifest.json").write_text('{"key": "k"}')
    (staging / "a.txt").write_text("hello")
    dest = tmp_path / "out.zip"
    pkg.write_zip(staging, dest, manifest_override={"name": "x"})
    with zipfile.ZipFile(dest) as zf:
        assert json.loads(zf.read("manifest.json")) == {"name": "x"}
        assert zf.read("a.txt") == b"hello"


def test_local_only_package_writes_current_metadata_without_upload(pkg, monkeypatch, tmp_path):
    extension_dir = tmp_path / "extension"
    downloads_dir = tmp_path / "downloads"
    build_dir = tmp_path / "build"
    (extension_dir / "dist").mkdir(parents=True)
    (extension_dir / "popup").mkdir()
    (extension_dir / "dist" / "background.js").write_text("bundle")
    (extension_dir / "popup" / "popup.html").write_text("<html></html>")
    models_dir = extension_dir / "public" / "models"
    models_dir.mkdir(parents=True)
    (models_dir / "student_model.onnx").write_bytes(b"fixture-model")
    (models_dir / "student_model.metadata.json").write_text(json.dumps({"version": "2.0.0"}))
    (extension_dir / "manifest.json").write_text(
        json.dumps({"name": "PhishGuard", "version": "0.4.13", "manifest_version": 3, "key": "test"})
    )

    monkeypatch.setattr(pkg, "EXTENSION_DIR", extension_dir)
    monkeypatch.setattr(pkg, "BACKEND_STATIC_DOWNLOADS", downloads_dir)
    monkeypatch.setattr(pkg, "BUILD_DIR", build_dir)
    monkeypatch.setattr(pkg, "ensure_extension_built", lambda force_rebuild=False: None)
    monkeypatch.setattr(pkg, "validate_model_bundle", lambda *_args: None)
    monkeypatch.setattr(pkg, "load_signing_key", lambda: b"test-key")
    monkeypatch.setattr(pkg, "assert_key_matches_manifest", lambda key, manifest: "a" * 32)
    monkeypatch.setattr(pkg, "get_update_base_url", lambda: "http://phishguard.local:8010")
    monkeypatch.setattr(pkg, "_store_artifacts_in_bucket", lambda *args: pytest.fail("unexpected upload"))

    def stub_crx(_staging, _key, destination, zip_path=None):
        destination.write_bytes(b"Cr24-test-package")
        return True

    monkeypatch.setattr(pkg, "pack_crx", stub_crx)
    result = pkg.package_extension(
        local_only=True,
        extension_dir=extension_dir,
        downloads_dir=downloads_dir,
        staging_parent=build_dir,
        backend_models_dir=tmp_path / "backend-models",
    )
    latest = json.loads((downloads_dir / "latest.json").read_text())
    disk_meta = json.loads((downloads_dir / "extension-meta.json").read_text())

    assert result["version"] == latest["version"] == disk_meta["version"] == "0.4.13"
    assert latest["sha256"] == disk_meta["sha256"] == pkg.compute_sha256(downloads_dir / "phishguard-extension.zip")
    assert latest["crx_sha256"] == disk_meta["crx_sha256"] == pkg.compute_sha256(downloads_dir / "phishguard-extension.crx")
    assert (downloads_dir / "phishguard-extension-v0.4.13.zip").exists()
    assert (downloads_dir / "phishguard-extension-v0.4.13.crx").exists()
    assert "http://phishguard.local:8010/download/phishguard-extension-v0.4.13.crx" in (
        downloads_dir / "updates.xml"
    ).read_text()


def test_real_local_key_matches_source_manifest(pkg):
    if not pkg.PEM_KEY_PATH.is_file():
        pytest.skip("local signing key not present")
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    pkg.assert_key_matches_manifest(pkg.PEM_KEY_PATH.read_bytes(), manifest)


def test_get_update_base_url_prefers_backend_url(pkg, clean_env):
    clean_env.setenv("BACKEND_URL", "https://api.phishguard.example.com/")
    clean_env.setenv("EXTENSION_UPDATE_BASE_URL", "https://legacy.example.com/")
    assert pkg.get_update_base_url() == "https://api.phishguard.example.com"


def test_get_update_base_url_falls_back_to_legacy_env(pkg, clean_env):
    clean_env.setenv("EXTENSION_UPDATE_BASE_URL", "https://legacy.example.com/")
    assert pkg.get_update_base_url() == "https://legacy.example.com"


def test_get_update_base_url_falls_back_to_gateway_domain(pkg, clean_env):
    clean_env.setenv("GATEWAY_DOMAIN", "phishguard-gateway-dev-1.example.com")
    assert pkg.get_update_base_url() == "https://phishguard-gateway-dev-1.example.com"

    clean_env.setenv("GATEWAY_DOMAIN", "localhost:8010")
    assert pkg.get_update_base_url() == "http://localhost:8010"


def test_get_update_base_url_none_when_unset(pkg, clean_env):
    assert pkg.get_update_base_url() is None

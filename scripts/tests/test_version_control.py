"""Unit tests for PhishGuard Version Control & Auto-Increment System."""

import json
import shutil
import subprocess
from pathlib import Path
import pytest

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT_DIR / "scripts" / "bump-version.mjs"

# Every file bump-version.mjs reads or writes, as repo-relative paths.
# Staged under tmp_path so the script never touches the real tree.
SCRIPT_TARGETS = (
    "version.json",
    "package.json",
    "apps/extension/package.json",
    "apps/extension/manifest.json",
    "apps/extension/popup/popup.html",
    "apps/landing/package.json",
    "apps/landing/lib/facts.ts",
    "packages/types/package.json",
)

# Real files whose bytes must survive this module unchanged.
GUARDED_FILES = (
    ROOT_DIR / "version.json",
    ROOT_DIR / "apps" / "extension" / "manifest.json",
)


@pytest.fixture(scope="module", autouse=True)
def guard_real_version_files():
    """Prove the bump-version tests never mutate the real repository files."""
    before = {path: path.read_bytes() for path in GUARDED_FILES}
    yield
    for path, content in before.items():
        assert path.read_bytes() == content, f"{path} was modified by the bump-version tests"


@pytest.fixture
def bump_env(tmp_path):
    """Hermetic copy of bump-version.mjs and every file it touches.

    The script derives ROOT_DIR from its own location, so staging it under
    tmp_path/scripts/ makes it operate exclusively on the staged copies.
    git lookups fall back to 'unknown' outside a repository, which is fine.
    """
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(parents=True)
    script = scripts_dir / "bump-version.mjs"
    shutil.copy2(SCRIPT_PATH, script)
    for relative in SCRIPT_TARGETS:
        source = ROOT_DIR / relative
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["node", str(script), *args],
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
        )

    return {"root": tmp_path, "run": run}


def read_version_parts(version_file: Path) -> tuple[int, int, int]:
    version = json.loads(version_file.read_text(encoding="utf-8"))["version"]
    parts = tuple(int(part) for part in version.split("."))
    assert len(parts) == 3
    return parts


def test_version_json_exists_and_valid(bump_env):
    version_file = bump_env["root"] / "version.json"
    assert version_file.exists(), "version.json must exist at root"
    data = json.loads(version_file.read_text(encoding="utf-8"))
    assert "version" in data
    major, minor, patch = (int(part) for part in data["version"].split("."))
    assert (data["major"], data["minor"], data["patch"]) == (major, minor, patch)
    assert isinstance(data["buildNumber"], int)
    assert "gitCommit" in data


def test_bump_version_current_output(bump_env):
    res = bump_env["run"]("--current")
    assert res.returncode == 0
    current_ver = res.stdout.strip()
    data = json.loads((bump_env["root"] / "version.json").read_text(encoding="utf-8"))
    assert current_ver == data["version"]


def test_bump_version_dry_run(bump_env):
    version_file = bump_env["root"] / "version.json"
    before_data = version_file.read_text(encoding="utf-8")
    res = bump_env["run"]("--dry-run")
    assert res.returncode == 0
    assert "Dry run:" in res.stdout
    after_data = version_file.read_text(encoding="utf-8")
    assert before_data == after_data, "dry-run must not modify version.json"


def test_bump_version_set_and_reset(bump_env):
    root = bump_env["root"]
    version_file = root / "version.json"
    manifest_file = root / "apps" / "extension" / "manifest.json"
    major, minor, _ = read_version_parts(version_file)
    target_version = f"{major}.{minor}.99"
    reset_version = f"{major}.{minor}.0"
    # Test setting explicit version
    res_set = bump_env["run"]("--set", target_version)
    assert res_set.returncode == 0
    data = json.loads(version_file.read_text(encoding="utf-8"))
    assert data["version"] == target_version
    assert data["patch"] == 99

    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    assert manifest["version"] == target_version

    # Test resetting back
    res_reset = bump_env["run"]("--reset")
    assert res_reset.returncode == 0
    data_reset = json.loads(version_file.read_text(encoding="utf-8"))
    assert data_reset["version"] == reset_version
    assert data_reset["patch"] == 0


def test_version_auto_increment_with_force(bump_env):
    root = bump_env["root"]
    version_file = root / "version.json"
    manifest_file = root / "apps" / "extension" / "manifest.json"
    pkg_file = root / "apps" / "extension" / "package.json"
    root_pkg = root / "package.json"
    major, minor, _ = read_version_parts(version_file)
    next_version = f"{major}.{minor}.1"
    bump_env["run"]("--reset")
    res1 = bump_env["run"]("--force")
    assert res1.returncode == 0
    data1 = json.loads(version_file.read_text(encoding="utf-8"))
    assert data1["version"] == next_version

    manifest1 = json.loads(manifest_file.read_text(encoding="utf-8"))
    assert manifest1["version"] == next_version

    pkg1 = json.loads(pkg_file.read_text(encoding="utf-8"))
    assert pkg1["version"] == next_version

    root_pkg1 = json.loads(root_pkg.read_text(encoding="utf-8"))
    assert root_pkg1["version"] == next_version

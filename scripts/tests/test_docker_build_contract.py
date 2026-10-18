from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DOCKERFILE = ROOT_DIR / "apps" / "backend" / "Dockerfile"
EXTENSION_DOCKERFILE = ROOT_DIR / "apps" / "extension" / "Dockerfile"


def test_local_and_release_builds_use_the_same_always_package_contract():
    local = (ROOT_DIR / "docker-compose.local.yml").read_text(encoding="utf-8")
    dokploy = (ROOT_DIR / "docker-compose.yml").read_text(encoding="utf-8")
    cloud_build = (ROOT_DIR / "cloudbuild.yaml").read_text(encoding="utf-8")
    local_gateway = local.split("  gateway:", 1)[1].split("\n  postgres:", 1)[0]
    dokploy_gateway = dokploy.split("  gateway:", 1)[1].split("\nsecrets:", 1)[0]

    assert "PACKAGE_EXTENSION" not in local_gateway
    assert "PACKAGE_EXTENSION" not in dokploy_gateway
    assert "PACKAGE_EXTENSION" not in cloud_build


def test_backend_docker_always_builds_and_packages_the_current_release():
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")
    build_stage = dockerfile.split("# --- Stage 2:", 1)[0]

    assert "PACKAGE_EXTENSION" not in build_stage
    assert "pnpm --filter @phishguard/types build" in build_stage
    assert "pnpm --filter @phishguard/landing build" in build_stage
    assert "pnpm --filter @phishguard/extension build" in build_stage
    assert build_stage.count("python3 scripts/package_extension.py --local-only") == 1
    assert build_stage.index("python3 scripts/package_extension.py --local-only") > build_stage.index(
        "pnpm --filter @phishguard/extension build"
    )
    assert "--mount=type=secret,id=EXTENSION_SIGNING_KEY_B64,required=true" in build_stage


def test_both_frontend_stages_copy_version_and_disable_build_bumps():
    for dockerfile_path in (BACKEND_DOCKERFILE, EXTENSION_DOCKERFILE):
        dockerfile = dockerfile_path.read_text(encoding="utf-8")
        build_stage = dockerfile.split("# --- Stage 2:", 1)[0] if dockerfile_path == BACKEND_DOCKERFILE else dockerfile.split("# ---- Stage 2:", 1)[0]
        assert "COPY version.json ./version.json" in build_stage
        assert "PHISHGUARD_SKIP_VERSION_BUMP=1" in build_stage
        assert "--mount=type=secret,id=EXTENSION_SIGNING_KEY_B64,required=true" in build_stage
        assert "python3 scripts/package_extension.py --local-only" in build_stage


def test_extension_distribution_docker_always_uses_strict_local_packaging():
    dockerfile = EXTENSION_DOCKERFILE.read_text(encoding="utf-8")
    build_stage = dockerfile.split("# ---- Stage 2:", 1)[0]

    assert "ARG PACKAGE_EXTENSION" not in build_stage
    assert build_stage.count("python3 scripts/package_extension.py --local-only") == 1

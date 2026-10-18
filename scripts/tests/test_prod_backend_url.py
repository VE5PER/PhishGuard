"""Prod builds must bake the prod gateway URL, never a dev placeholder."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
FAKE_PROJECT_NUMBER = "123456789012"
EXPECTED_PROD_URL = f"https://phishguard-gateway-prod-{FAKE_PROJECT_NUMBER}.asia-south1.run.app"
PROD_URL_SHAPE = re.compile(r"^https://phishguard-gateway-prod-[^./]+\.asia-south1\.run\.app$")
DERIVATION = (
    'EFFECTIVE_BACKEND_URL="https://phishguard-gateway-${_ENV}-$PROJECT_NUMBER.${_REGION}.run.app"'
)
BUILD_ARG = '--build-arg BACKEND_URL="$$EFFECTIVE_BACKEND_URL"'

PIPELINES = {
    "cloudbuild.yaml": "build-gateway",
    "deploy/gcp/cloudbuild.extension.yaml": "build-extension",
}


def _load(rel: str) -> dict:
    return yaml.safe_load((ROOT / rel).read_text(encoding="utf-8"))


def _build_script(rel: str) -> str:
    step_id = PIPELINES[rel]
    step = next(s for s in _load(rel)["steps"] if s["id"] == step_id)
    return step["args"][-1]


@pytest.mark.parametrize("rel", PIPELINES)
def test_substitution_defaults_are_empty(rel: str) -> None:
    subs = _load(rel)["substitutions"]
    assert subs["_BACKEND_URL"] == ""
    assert subs["_GATEWAY_DOMAIN"] == ""
    text = (ROOT / rel).read_text(encoding="utf-8")
    for line in text.splitlines():
        if re.match(r"\s*_(BACKEND_URL|GATEWAY_DOMAIN):", line):
            assert "example.com" not in line.split("#", 1)[0]


@pytest.mark.parametrize("rel", PIPELINES)
def test_build_step_derives_and_passes_backend_url(rel: str) -> None:
    script = _build_script(rel)
    assert DERIVATION in script
    assert BUILD_ARG in script
    assert script.index(DERIVATION) < script.index("docker build")


def test_derivation_yields_prod_url() -> None:
    match = re.search(r'EFFECTIVE_BACKEND_URL="(https://[^"]+)"', DERIVATION)
    assert match
    resolved = (
        match.group(1)
        .replace("${_ENV}", "prod")
        .replace("$PROJECT_NUMBER", FAKE_PROJECT_NUMBER)
        .replace("${_REGION}", "asia-south1")
    )
    assert resolved == EXPECTED_PROD_URL


def test_prod_env_template_resolves_prod_backend_url() -> None:
    values: dict[str, str] = {}
    for line in (ROOT / "deploy/env/.env.prod.example").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = re.sub(
            r"\$\{(\w+)\}", lambda m: values.get(m.group(1), ""), value.strip()
        )
    assert values["BACKEND_URL"] == "https://" + values["GATEWAY_DOMAIN"]
    assert PROD_URL_SHAPE.fullmatch(values["BACKEND_URL"])

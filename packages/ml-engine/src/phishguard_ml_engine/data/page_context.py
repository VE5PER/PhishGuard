import re
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

import numpy as np

from .feature_extractor import BRAND_LEGITIMATE_DOMAINS
from .trajectory_preprocessor import PreparedTrajectory


PAGE_CONTEXT_FEATURES = (
    "url_userinfo", "hostname_brand_mismatch", "path_query_brand_mention", "credential_present",
    "credential_overlay", "submit_overlay", "other_overlay", "observed_cross_origin_credential",
    "unverified_cross_origin_frame", "password_paste", "pointer_coverage", "duration_coverage",
    "trajectory_available", "visual_available", "page_context_available", "https",
)
BRAND_DOMAINS = {re.sub(r"\s+", "", key): value for key, value in BRAND_LEGITIMATE_DOMAINS.items()}
RISK_POLICY_VERSION = "evidence-v2"


def normalize_hostname(host: str) -> str:
    if any(character in host for character in "/?#@"):
        return ""
    try:
        authority = f"[{host}]" if host.count(":") > 1 and not host.startswith("[") else host
        normalized = urlsplit(f"https://{authority.rstrip('.')}").hostname or ""
        return normalized.encode("idna").decode("ascii").lower().rstrip(".")
    except (UnicodeError, ValueError):
        return ""


def authorized_brand_host(host: str, brand: str) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in BRAND_DOMAINS.get(brand, ()))


def deduplicate_evidence(events: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    result = []
    for event in events:
        key = (
            str(event.get("evidenceId") or event.get("elementSelector", "")),
            str(event.get("coveredControlType", "none")),
            str(event.get("credentialFrameEvidence", "none")),
        )
        if key not in seen:
            result.append(event)
            seen.add(key)
    return result


def prepare_page_context(
    payload: Mapping[str, Any], trajectory: PreparedTrajectory, visual_available: bool
) -> dict[str, Any]:
    context = np.zeros(16, dtype=np.float32)
    result: dict[str, Any] = dict(
        context=context, available=False, hostname="", brand=None, deceptive_host=False,
        credential_traps=0, submit_traps=0, other_traps=0, observed_credential_frame=False,
    )
    try:
        parsed = urlsplit(str(payload.get("url", "")))
        host = normalize_hostname(parsed.hostname or "")
        if parsed.scheme not in ("http", "https") or not host or normalize_hostname(str(payload.get("domain", ""))) != host:
            return result
    except ValueError:
        return result
    tokens = re.split(r"[.-]", host)
    brand = next((name for name in BRAND_DOMAINS if name in tokens and not authorized_brand_host(host, name)), None)
    mentions = re.split(r"[^a-z0-9]+", (parsed.path + " " + parsed.query).lower())
    events = deduplicate_evidence(payload.get("domEvents", []))
    traps = [
        event for event in events
        if event.get("evidenceSource") in ("observed_interaction", "topology_scan")
        and event.get("isZeroOpacity") and event.get("isHitTestIntercepting")
    ]
    credential = sum(event.get("coveredControlType") == "password" for event in traps)
    submit = sum(event.get("coveredControlType") == "submit" for event in traps)
    other = sum(event.get("coveredControlType") == "other" for event in traps)
    observed = any(
        event.get("evidenceSource") == "observed_interaction" and event.get("credentialFrameEvidence") == "observed"
        and event.get("isCrossOriginIframe") and event.get("isPasswordInput") for event in events
    )
    context[:] = (
        bool(parsed.username or parsed.password), brand is not None, any(name in mentions for name in BRAND_DOMAINS),
        bool(payload.get("hasCredentialField")), credential > 0, submit > 0, other > 0, observed,
        any(event.get("isCrossOriginIframe") and event.get("credentialFrameEvidence") != "observed" for event in events),
        any(event.get("isPasteIntoPassword") for event in events),
        min(trajectory.valid_point_count / 128, 1), min(trajectory.duration_ms / 2000, 1),
        trajectory.available, visual_available, 1, parsed.scheme == "https",
    )
    result.update(
        available=True, hostname=host, brand=brand,
        deceptive_host=brand is not None and any(token in ("verify", "signin", "login", "security", "secure", "recovery", "account") for token in tokens),
        credential_traps=credential, submit_traps=submit, other_traps=other, observed_credential_frame=observed,
    )
    return result


def evaluate_evidence_risk(page: Mapping[str, Any]) -> dict[str, Any]:
    score = 0.05
    reasons: list[str] = []
    rule_ids: list[str] = []

    def add(value: float, rule_id: str, reason: str) -> None:
        nonlocal score
        score = max(score, value)
        reasons.append(reason)
        rule_ids.append(rule_id)

    if not page["available"]:
        return dict(score=score, reasons=["Page context unavailable"], rule_ids=rule_ids)
    credential, submit, other = (page[key] for key in ("credential_traps", "submit_traps", "other_traps"))
    if credential + submit + other:
        add(0.40, "intercepting_overlay", "A persistent transparent overlay intercepts an interactive control")
    if credential and credential + submit >= 2:
        add(0.90, "credential_and_submit_interception", "Distinct transparent traps intercept credential and submission controls")
    if credential and page["observed_credential_frame"]:
        add(0.90, "corroborated_credential_interception", "Credential interception is corroborated by an observed foreign-frame credential interaction")
    if page["context"][0]:
        add(0.90 if page["context"][3] else 0.40, "deceptive_authority", "The URL contains an authority userinfo separator")
    if page["deceptive_host"] and page["context"][3]:
        add(0.65, "deceptive_brand_login_host", "A brand-bearing authentication hostname is not an authorized host for that brand")
    return dict(score=score, reasons=reasons, rule_ids=rule_ids)


def compose_risk(model_score: float | None, evidence_score: float) -> tuple[float, str]:
    model = model_score if model_score is not None and np.isfinite(model_score) and 0 <= model_score <= 1 else 0
    score = float(np.floor(max(model, evidence_score) * 1_000_000 + 0.5) / 1_000_000)
    return score, "BLOCK" if score > 0.85 else "AMBIGUOUS" if score >= 0.15 else "SAFE"

from typing import Any

from phishguard_ml_engine.data.page_context import (
    authorized_brand_host, compose_risk, evaluate_evidence_risk, prepare_page_context,
)
from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from phishguard_types import EscalationPayload


def cloud_evidence_snapshot(payload: EscalationPayload) -> dict[str, Any]:
    points = [point.model_dump() for point in payload.mouseTrajectorySeries]
    events = [event.model_dump() for event in payload.domElementsSummary]
    has_credential = bool(getattr(payload, "hasCredentialField", False)) or any(
        event.get("isPasswordInput") or event.get("coveredControlType") == "password" for event in events
    )
    page = prepare_page_context(
        dict(url=str(payload.url), domain=payload.domain, domEvents=events, hasCredentialField=has_credential),
        prepare_trajectory(points), bool(payload.screenshotBase64),
    )
    policy = evaluate_evidence_risk(page)
    return dict(page=page, policy=policy)


def trusted_client_risk(payload: EscalationPayload, metadata: Any | None) -> float | None:
    if metadata is None:
        return None
    summary = getattr(metadata, "validationSummary", None)
    contract = getattr(metadata, "inputContract", None)
    if summary is None or contract is None:
        return None
    if not (
        summary.passedAllGates and summary.modelSha256 == metadata.sha256
        and summary.inputContractIdentifier == "student-v2" and summary.policyVersion == "evidence-v2"
        and summary.benignWarningCount == 0 and summary.criticalMissCount == 0
        and summary.falsePositiveRate <= 0.005 and contract.identifier == "student-v2"
        and getattr(payload, "clientModelSha256", None) == metadata.sha256
        and getattr(payload, "clientModelVersion", None) == metadata.version
        and getattr(payload, "clientInputContract", None) == "student-v2"
    ):
        return None
    return payload.clientRiskScore


def compose_cloud_verdict(snapshot: dict[str, Any], client_risk: float | None, vision_match: Any | None) -> dict[str, Any]:
    page, policy = snapshot["page"], snapshot["policy"]
    score = policy["score"]
    reasons = list(policy["reasons"])
    brand = page["brand"] if page["deceptive_host"] and page["context"][3] else None
    vision_used = vision_match is not None
    if vision_match is not None:
        confident = (
            vision_match.similarity >= 0.80
            and vision_match.similarity - vision_match.generic_similarity >= 0.05
            and vision_match.similarity - vision_match.runner_up_similarity >= 0.03
        )
        if confident and page["available"] and not authorized_brand_host(page["hostname"], vision_match.brand):
            if page["context"][3]:
                corroborated = page["credential_traps"] > 0 or page["context"][0] or page["deceptive_host"]
                score = max(score, 0.90 if corroborated else 0.65)
                brand = vision_match.brand
                reasons.append("A consented screenshot resembles a brand login on an unauthorized host; credential context is present")
            else:
                reasons.append("Visual resemblance alone does not establish phishing")
    risk, route = compose_risk(client_risk, score)
    if route == "BLOCK":
        action, phishing, confidence = "BLOCK", True, risk
        if not reasons:
            reasons.append("A recognized validated on-device model reports high risk")
    elif risk >= 0.40:
        action, phishing, confidence = "WARN", False, risk
        if not reasons:
            reasons.append("Uncertain page evidence warrants caution")
    else:
        action, phishing, confidence = "ALLOW", False, 1 - risk
        if not reasons:
            reasons.append("No actionable deceptive-page evidence observed")
    return dict(
        risk_score=risk, action=action, is_phishing=phishing, confidence=confidence,
        target_brand=brand, reasons=reasons, vision_used=vision_used,
    )


def can_use_reputation_prior(snapshot: dict[str, Any], client_risk: float | None, has_screenshot: bool) -> bool:
    return (
        snapshot["page"]["available"] and snapshot["policy"]["score"] == 0.05
        and not snapshot["policy"]["rule_ids"] and not has_screenshot
        and (client_risk is None or client_risk < 0.15)
    )


def verdict_cache_key(
    payload: EscalationPayload,
    snapshot: dict[str, Any],
    client_risk: float | None = None,
    validation_report_sha256: str | None = None,
) -> str:
    import hashlib
    import json
    from urllib.parse import urlsplit, urlunsplit

    parsed = urlsplit(str(payload.url))
    host = snapshot["page"]["hostname"]
    authority = f"[{host}]" if ":" in host else host
    if parsed.port is not None and parsed.port != (443 if parsed.scheme == "https" else 80):
        authority += f":{parsed.port}"
    canonical = urlunsplit((parsed.scheme.lower(), authority, parsed.path or "/", parsed.query, ""))
    fingerprint = dict(
        url=canonical, policy="evidence-v2", context=snapshot["page"]["context"].tolist(),
        model_version=getattr(payload, "clientModelVersion", None),
        model_hash=getattr(payload, "clientModelSha256", None),
        model_contract=getattr(payload, "clientInputContract", None), client_score=payload.clientRiskScore,
        accepted_client_risk=client_risk,
        accepted_validation_report_sha256=validation_report_sha256,
        screenshot_hash=hashlib.sha256(payload.screenshotBase64.encode()).hexdigest() if payload.screenshotBase64 else None,
    )
    return "verdict-v2:" + hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

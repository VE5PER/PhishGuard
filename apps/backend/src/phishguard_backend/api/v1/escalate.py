"""Escalation API endpoint for ambiguous edge telemetry."""

import logging
from datetime import datetime, timezone
from uuid import uuid4
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from dataclasses import dataclass
from typing import Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession

from phishguard_types import (
    CloudActionOverride,
    CloudInferenceVerdict,
    EscalationPayload,
    ScreenAnalysis,
    TeacherTrace,
    TeacherTraceStatus,
)
from ...services.auth import auth_service
from ...services.cache import reputation_cache
from ...services.cloud_inference import cloud_dispatcher
from ...services.evidence_policy import (
    can_use_reputation_prior,
    cloud_evidence_snapshot,
    trusted_client_risk,
    verdict_cache_key,
)
from ...services.gemini_agent import GeminiTeacherConfig
from ...services.model_registry import model_registry
from ...services.rate_limit import gemini_escalate_limiter
from ...db import get_db, EscalationAuditRecord

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1", tags=["escalate"])


def _cached_verdict(entry: dict, telemetry_id) -> CloudInferenceVerdict:
    return CloudInferenceVerdict(
        analysisId=uuid4(),
        telemetryId=telemetry_id,
        isPhishing=entry["is_phishing"],
        targetBrand=entry.get("target_brand"),
        confidence=entry["confidence"],
        actionOverride=CloudActionOverride(entry["action"]),
        explanationReasons=entry.get("reasons", []),
        teacherModelVersion=entry.get("teacher_model_version", "cloud-evidence-v2"),
        evaluatedAt=datetime.now(timezone.utc),
        riskScore=entry.get("risk_score"),
        screenAnalysis=ScreenAnalysis(**entry["screen_analysis"]) if entry.get("screen_analysis") else None,
    )


@dataclass(frozen=True)
class EscalationContext:
    snapshot: dict[str, Any]
    metadata: Any
    client_risk: Optional[float]
    verdict_key: str


def build_escalation_context(payload: EscalationPayload) -> EscalationContext:
    snapshot = cloud_evidence_snapshot(payload)
    if not snapshot["page"]["available"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Telemetry URL host must match the supplied page domain",
        )
    metadata = (
        model_registry.get_metadata(payload.clientModelVersion)
        if payload.clientModelVersion
        else None
    )
    client_risk = trusted_client_risk(payload, metadata)
    validation_report_sha256 = None
    if client_risk is not None and metadata is not None and metadata.validationSummary is not None:
        validation_report_sha256 = metadata.validationSummary.reportSha256
    verdict_key = verdict_cache_key(
        payload,
        snapshot,
        client_risk=client_risk,
        validation_report_sha256=validation_report_sha256,
    )
    return EscalationContext(snapshot, metadata, client_risk, verdict_key)


def gemini_cache_key(model: str, verdict_key: str) -> str:
    return f"gemini-v1:{model}:{verdict_key}"


def cache_verdict(key: str, verdict: CloudInferenceVerdict) -> None:
    reputation_cache.set_verdict(
        key,
        is_phishing=verdict.isPhishing,
        confidence=verdict.confidence,
        target_brand=verdict.targetBrand,
        action=verdict.actionOverride.value,
        reasons=verdict.explanationReasons,
        teacher_model_version=verdict.teacherModelVersion,
        risk_score=verdict.riskScore,
        screen_analysis=verdict.screenAnalysis.model_dump() if verdict.screenAnalysis else None,
    )


async def gemini_verdict_cached_or_fresh(
    payload: EscalationPayload, ctx: EscalationContext
) -> tuple[CloudInferenceVerdict, TeacherTrace]:
    config = GeminiTeacherConfig.from_env()
    key = gemini_cache_key(config.model, ctx.verdict_key)
    cached = reputation_cache.get_verdict(key)
    if cached:
        trace = TeacherTrace(
            status=TeacherTraceStatus.OK,
            model=config.model,
            toolCalls=[],
            latencyMs=0.0,
            cached=True,
            fallbackReason=None,
        )
        return _cached_verdict(cached, payload.telemetryId), trace
    verdict, trace = await cloud_dispatcher.evaluate_with_trace(payload, ctx.snapshot, ctx.metadata)
    if trace.status == TeacherTraceStatus.OK:
        cache_verdict(key, verdict)
    return verdict, trace


async def persist_audit(db: AsyncSession, payload: EscalationPayload, verdict: CloudInferenceVerdict) -> None:
    try:
        audit = EscalationAuditRecord(
            telemetry_id=str(payload.telemetryId),
            url=str(payload.url),
            domain=payload.domain,
            client_risk_score=payload.clientRiskScore,
            is_phishing=verdict.isPhishing,
            target_brand=verdict.targetBrand,
            action_override=verdict.actionOverride.value,
            explanation_reasons=verdict.explanationReasons,
            teacher_model_version=verdict.teacherModelVersion,
            created_at=datetime.now(timezone.utc),
        )
        db.add(audit)
        await db.commit()
    except Exception as exc:
        try:
            await db.rollback()
        except Exception:
            pass
        logger.warning("Audit persistence unavailable (%s)", type(exc).__name__)


@router.post("/escalate", response_model=CloudInferenceVerdict)
async def escalate_telemetry(
    payload: EscalationPayload,
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> CloudInferenceVerdict:
    """Gemini ADK forensic teacher when configured; evidence-v2 otherwise."""
    # 1. Verify Client Authentication
    auth_service.verify_client_token(authorization)

    ctx = build_escalation_context(payload)
    page = ctx.snapshot["page"]
    gemini_configured = GeminiTeacherConfig.from_env().configured

    # 2. Check Reputation Cache for fast-path return (URL key first, then domain fallback)
    verdict = None
    if not gemini_configured:
        cached = reputation_cache.get_verdict(ctx.verdict_key)
        verdict = _cached_verdict(cached, payload.telemetryId) if cached else None
    if verdict is None and can_use_reputation_prior(ctx.snapshot, ctx.client_risk, bool(payload.screenshotBase64)):
        prior = reputation_cache.get_reputation_prior(page["hostname"])
        if prior:
            verdict = _cached_verdict(prior, payload.telemetryId)

    if verdict is None and gemini_configured:
        # 3a. Gemini ADK teacher (namespaced cache; degrades to evidence-v2 fallback)
        verdict, _trace = await gemini_verdict_cached_or_fresh(payload, ctx)
    elif verdict is None:
        # 3b. Deterministic evidence-v2 inference
        verdict = await cloud_dispatcher.evaluate(payload, ctx.snapshot, ctx.metadata)

        # 4. Cache verdict for future queries
        if not verdict.teacherModelVersion.endswith("-fallback"):
            cache_verdict(ctx.verdict_key, verdict)

    # 5. Persist forensic audit record to database
    await persist_audit(db, payload, verdict)
    return verdict


@router.post("/escalate/gemini", response_model=CloudInferenceVerdict)
async def escalate_telemetry_gemini(
    payload: EscalationPayload,
    request: Request,
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> CloudInferenceVerdict:
    """Gemini forensic teacher route; forwards the consented screenshot to the Gemini API."""
    gemini_escalate_limiter.enforce(request)
    auth_service.verify_client_token(authorization)

    ctx = build_escalation_context(payload)
    verdict, _trace = await gemini_verdict_cached_or_fresh(payload, ctx)
    await persist_audit(db, payload, verdict)
    return verdict

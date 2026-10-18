"""Cloud Teacher Multimodal Inference Dispatcher."""

import asyncio
from datetime import datetime, timezone
import logging
import re
import time
from typing import Any, Optional
from uuid import uuid4

from phishguard_ml_engine.data.page_context import authorized_brand_host
from phishguard_types import (
    CloudActionOverride,
    CloudInferenceVerdict,
    EscalationPayload,
    ScreenAnalysis,
    TeacherTrace,
    TeacherTraceStatus,
)

from .evidence_policy import (
    cloud_evidence_snapshot,
    compose_cloud_verdict,
    trusted_client_risk,
)
from .gemini_agent import (
    GeminiForensicFinding,
    GeminiForensicTeacher,
    GeminiTeacherConfig,
    CallBudget,
    CircuitBreaker,
    call_budget,
    circuit_breaker,
    gemini_teacher,
)
from .vision import VisionAnalyzer, VisionMatch, vision_analyzer

logger = logging.getLogger(__name__)

BASELINE_VERSION = "cloud-evidence-v2"
FALLBACK_VERSION = "cloud-evidence-v2-fallback"
FALLBACK_REASON = "Automated fallback applied: cloud AI teacher unavailable"
BLOCK_CONFIDENCE_FLOOR = 0.70
MAX_REASONS = 8
ALLOW_RISK_CEILING = 0.15
BLOCK_RISK_FLOOR = 0.85
WARN_FLOOR_REASON = "No proof the page is safe; deterministic evidence keeps the warning"


def _clamp_to_band(risk: float, action: str) -> float:
    if action == "ALLOW":
        return min(risk, ALLOW_RISK_CEILING)
    if action == "BLOCK":
        return max(risk, BLOCK_RISK_FLOOR)
    return min(max(risk, ALLOW_RISK_CEILING), BLOCK_RISK_FLOOR)


def apply_safety_rails(
    finding: GeminiForensicFinding,
    baseline: dict[str, Any],
    page: dict[str, Any],
    has_screenshot: bool = True,
) -> dict[str, Any]:
    reasons = list(finding.reasons)
    action, confidence = finding.action, finding.confidence
    risk = finding.risk_score
    screen = finding.screen_analysis if has_screenshot else None
    screen_score = screen.screen_risk_score if screen else None
    brand = re.sub(r"\s+", "", finding.target_brand or "").lower() or None
    claims_phishing = finding.is_phishing
    if brand and authorized_brand_host(page["hostname"], brand):
        action, confidence, claims_phishing = baseline["action"], baseline["confidence"], False
        risk = baseline["risk_score"]
        if screen_score is not None:
            screen_score = min(screen_score, risk)
        reasons = [*baseline["reasons"], f"Brand claim contradicted by registry: host is authorized for {brand}"]
    elif action == "BLOCK" and confidence < BLOCK_CONFIDENCE_FLOOR:
        action = "WARN"
        reasons.append("Cloud AI block confidence below threshold; downgraded to warning")
    if baseline["action"] == "BLOCK" and action != "BLOCK":
        action, confidence = "BLOCK", baseline["confidence"]
        reasons.extend(baseline["reasons"])
    if baseline["action"] == "BLOCK":
        risk = max(risk, baseline["risk_score"])
    if baseline["action"] == "WARN" and action == "ALLOW":
        action, confidence = "WARN", baseline["confidence"]
        risk = max(risk, baseline["risk_score"])
        reasons = [*baseline["reasons"], WARN_FLOOR_REASON, *reasons]
    risk = _clamp_to_band(risk, action)
    target_brand = brand if claims_phishing and brand else baseline["target_brand"]
    screen_analysis = None
    if screen is not None:
        screen_analysis = dict(
            screenRiskScore=screen_score,
            detectedBrand=screen.detected_brand,
            credentialFormVisible=screen.credential_form_visible,
            urgencyCues=list(screen.urgency_cues),
            onScreenUrlMismatch=screen.on_screen_url_mismatch,
            reasons=list(screen.reasons),
        )
    return dict(
        action=action,
        is_phishing=action == "BLOCK",
        confidence=confidence,
        target_brand=target_brand,
        reasons=list(dict.fromkeys(reasons))[:MAX_REASONS],
        risk_score=risk,
        screen_analysis=screen_analysis,
    )


class CloudInferenceDispatcher:
    """Dispatches ambiguous client telemetry to cloud Teacher models and generates verdicts."""

    def __init__(
        self,
        analyzer: Optional[VisionAnalyzer] = None,
        teacher: Optional[GeminiForensicTeacher] = None,
        breaker: Optional[CircuitBreaker] = None,
        budget: Optional[CallBudget] = None,
    ):
        self.vision_analyzer = analyzer or vision_analyzer
        self.teacher = teacher or gemini_teacher
        self.breaker = breaker or circuit_breaker
        self.budget = budget or call_budget

    async def _baseline(
        self,
        payload: EscalationPayload,
        snapshot: Optional[dict[str, Any]],
        recognized_metadata: Any | None,
    ) -> tuple[dict[str, Any], dict[str, Any], Optional[float]]:
        # 1. Behavioral Stream Analysis
        client_risk = trusted_client_risk(payload, recognized_metadata)

        # 2. DOM Topology & Screen Behavior Heuristics
        evidence = snapshot if snapshot is not None else cloud_evidence_snapshot(payload)
        vision_match: Optional[VisionMatch] = None
        # 3. Domain & Full URL Heuristics & Brand Grounding
        # 4. Visual brand matching on a consented screenshot
        if payload.screenshotBase64:
            try:
                vision_match = await asyncio.to_thread(self.vision_analyzer.match, payload.screenshotBase64)
            except Exception as exc:
                logger.warning("Vision analysis unavailable (%s)", type(exc).__name__)

        # 5. Multimodal Fusion Calculation
        # Combine client edge risk score, cloud behavioral inference, and DOM topological signals
        return compose_cloud_verdict(evidence, client_risk, vision_match), evidence, client_risk

    @staticmethod
    def _verdict(payload: EscalationPayload, decision: dict[str, Any], version: str) -> CloudInferenceVerdict:
        return CloudInferenceVerdict(
            analysisId=uuid4(),
            telemetryId=payload.telemetryId,
            isPhishing=decision["is_phishing"],
            targetBrand=decision["target_brand"],
            confidence=decision["confidence"],
            actionOverride=CloudActionOverride(decision["action"]),
            explanationReasons=decision["reasons"],
            teacherModelVersion=version,
            evaluatedAt=datetime.now(timezone.utc),
            riskScore=decision.get("risk_score"),
            screenAnalysis=ScreenAnalysis(**decision["screen_analysis"]) if decision.get("screen_analysis") else None,
        )

    async def evaluate(
        self,
        payload: EscalationPayload,
        snapshot: Optional[dict[str, Any]] = None,
        recognized_metadata: Any | None = None,
        *,
        use_teacher: bool = False,
    ) -> CloudInferenceVerdict:
        """Execute cloud evaluation; Gemini is consulted only when use_teacher is set."""
        if use_teacher:
            verdict, _trace = await self.evaluate_with_trace(payload, snapshot, recognized_metadata)
            return verdict
        decision, _evidence, _client_risk = await self._baseline(payload, snapshot, recognized_metadata)
        return self._verdict(payload, decision, BASELINE_VERSION)

    async def evaluate_with_trace(
        self,
        payload: EscalationPayload,
        snapshot: Optional[dict[str, Any]] = None,
        recognized_metadata: Any | None = None,
    ) -> tuple[CloudInferenceVerdict, TeacherTrace]:
        """Gemini-assisted evaluation. Never raises on teacher failure; falls back to evidence-v2."""
        baseline, evidence, client_risk = await self._baseline(payload, snapshot, recognized_metadata)
        config = GeminiTeacherConfig.from_env()
        started = time.perf_counter()
        status, reason, tool_calls = TeacherTraceStatus.OK, None, []
        decision, version = baseline, ""
        fallback = dict(baseline, reasons=[*baseline["reasons"], FALLBACK_REASON])

        if not config.configured:
            status, reason = TeacherTraceStatus.UNCONFIGURED, "not_configured"
        elif not self.breaker.allow():
            status, reason = TeacherTraceStatus.CIRCUIT_OPEN, "circuit_open"
        elif not self.budget.try_acquire(config.max_calls_per_hour):
            self.breaker.release_probe()
            status, reason = TeacherTraceStatus.BUDGET_EXHAUSTED, "budget_exhausted"
        else:
            try:
                finding, tool_calls = await self.teacher.evaluate(payload, evidence, client_risk)
                decision = apply_safety_rails(finding, baseline, evidence["page"], bool(payload.screenshotBase64))
                version = f"gemini-adk/{config.model}"
                self.breaker.record_success()
            except asyncio.CancelledError:
                self.breaker.release_probe()
                raise
            except Exception as exc:
                logger.warning("Gemini teacher unavailable (%s)", type(exc).__name__)
                self.breaker.record_failure()
                status, reason, tool_calls = TeacherTraceStatus.FALLBACK, type(exc).__name__, []

        if status != TeacherTraceStatus.OK:
            decision, version = fallback, FALLBACK_VERSION
        trace = TeacherTrace(
            status=status,
            model=config.model,
            toolCalls=tool_calls,
            latencyMs=round((time.perf_counter() - started) * 1000, 3),
            cached=False,
            fallbackReason=reason,
        )
        return self._verdict(payload, decision, version), trace


cloud_dispatcher = CloudInferenceDispatcher()

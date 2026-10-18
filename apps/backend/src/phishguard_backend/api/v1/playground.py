"""Public interactive playground: curated scenarios run through both cloud teachers.

Playground runs never write audit rows; the database session is only handed to
read-only threat-memory lookups.
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable, TypeVar
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, status

from phishguard_types import (
    DOMEvidenceSource,
    CloudInferenceVerdict,
    PlaygroundGeminiResult,
    PlaygroundRunRequest,
    PlaygroundRunResponse,
    PlaygroundScenarioList,
    PlaygroundTeacherResult,
    TeacherTrace,
)
from ...playground import get_scenario, load_scenarios
from ...services.cache import reputation_cache
from ...services.cloud_inference import cloud_dispatcher
from ...services.gemini_agent import GeminiTeacherConfig
from ...services.rate_limit import playground_run_limiter
from .escalate import (
    _cached_verdict,
    build_escalation_context,
    cache_verdict,
    gemini_verdict_cached_or_fresh,
)

router = APIRouter(prefix="/v1/playground", tags=["playground"])

T = TypeVar("T")


async def _timed(call: Callable[[], Awaitable[T]]) -> tuple[T, float]:
    started = time.perf_counter()
    result = await call()
    return result, round((time.perf_counter() - started) * 1000, 3)


@router.get("/scenarios", response_model=PlaygroundScenarioList)
async def list_scenarios() -> PlaygroundScenarioList:
    config = GeminiTeacherConfig.from_env()
    return PlaygroundScenarioList(
        scenarios=list(load_scenarios()),
        geminiConfigured=config.configured,
        geminiModel=config.model if config.configured else None,
    )


@router.post("/scenarios/{scenario_id}/run", response_model=PlaygroundRunResponse)
async def run_scenario(scenario_id: str, body: PlaygroundRunRequest, request: Request) -> PlaygroundRunResponse:
    scenario = get_scenario(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown playground scenario")
    playground_run_limiter.enforce(request)

    interaction_update = {}
    if body.interaction is not None:
        interaction = body.interaction
        interaction_update = {
            "mouseTrajectorySeries": interaction.mouseTrajectorySeries,
            "keystrokesSummary": interaction.keystrokesSummary,
            "domElementsSummary": [
                *(
                    event
                    for event in scenario.payload.domElementsSummary
                    if event.evidenceSource == DOMEvidenceSource.TOPOLOGY_SCAN
                ),
                *interaction.observedDomEvents,
            ],
        }
    payload = scenario.payload.model_copy(
        update={
            **interaction_update,
            "telemetryId": uuid4(),
            "clientTimestamp": datetime.now(timezone.utc),
            "clientRiskScore": round(body.clientRiskScore, 3),
            "clientModelVersion": body.clientModelVersion,
            "clientModelSha256": body.clientModelSha256,
            "clientInputContract": body.clientInputContract,
        }
    )
    ctx = build_escalation_context(payload)

    async def evidence() -> tuple[CloudInferenceVerdict, bool]:
        cached = reputation_cache.get_verdict(ctx.verdict_key)
        if cached:
            return _cached_verdict(cached, payload.telemetryId), True
        verdict = await cloud_dispatcher.evaluate(payload, ctx.snapshot, ctx.metadata)
        if not verdict.teacherModelVersion.endswith("-fallback"):
            cache_verdict(ctx.verdict_key, verdict)
        return verdict, False

    async def gemini() -> tuple[CloudInferenceVerdict, TeacherTrace]:
        return await gemini_verdict_cached_or_fresh(payload, ctx)

    ((evidence_verdict, evidence_cached), evidence_ms), ((gemini_verdict, trace), gemini_ms) = await asyncio.gather(
        _timed(evidence), _timed(gemini)
    )
    return PlaygroundRunResponse(
        payload=payload,
        evidence=PlaygroundTeacherResult(verdict=evidence_verdict, latencyMs=evidence_ms, cached=evidence_cached),
        gemini=PlaygroundGeminiResult(verdict=gemini_verdict, latencyMs=gemini_ms, cached=trace.cached, trace=trace),
    )

from datetime import datetime, timezone
from uuid import uuid4

from phishguard_types import EscalationPayload
from phishguard_backend.services.evidence_policy import (
    can_use_reputation_prior,
    cloud_evidence_snapshot,
    compose_cloud_verdict,
    verdict_cache_key,
)


def payload(url="https://quiet.test/login", events=()):
    from urllib.parse import urlsplit
    return EscalationPayload(
        telemetryId=uuid4(), url=url, domain=urlsplit(url).hostname, clientRiskScore=0.99,
        mouseTrajectorySeries=[], domElementsSummary=list(events), clientTimestamp=datetime.now(timezone.utc),
    )


def test_unverified_legacy_score_is_not_a_random_teacher():
    value = payload()
    snapshot = cloud_evidence_snapshot(value)
    assert compose_cloud_verdict(snapshot, None, None)["action"] == "ALLOW"
    assert compose_cloud_verdict(snapshot, 0.99, None)["action"] == "BLOCK"


def test_cache_preserves_url_case_and_separates_evidence():
    lower, upper = payload("https://quiet.test/Login?q=Case"), payload("https://quiet.test/login?q=case")
    assert verdict_cache_key(lower, cloud_evidence_snapshot(lower)) != verdict_cache_key(upper, cloud_evidence_snapshot(upper))
    assert verdict_cache_key(lower, cloud_evidence_snapshot(lower)) == verdict_cache_key(lower, cloud_evidence_snapshot(lower))
    claimed = lower.model_copy(update={
        "clientModelVersion": "2.0.0",
        "clientModelSha256": "a" * 64,
        "clientInputContract": "student-v2",
    })
    claimed_snapshot = cloud_evidence_snapshot(claimed)
    unrecognized_key = verdict_cache_key(claimed, claimed_snapshot, None, None)
    recognized_key = verdict_cache_key(claimed, claimed_snapshot, 0.99, "b" * 64)
    assert recognized_key != unrecognized_key
    assert verdict_cache_key(claimed, claimed_snapshot, 0.0, "b" * 64) != unrecognized_key


def test_reputation_prior_is_limited_to_neutral_unconsented_evidence():
    neutral = cloud_evidence_snapshot(payload())
    assert can_use_reputation_prior(neutral, None, False)
    assert not can_use_reputation_prior(neutral, 0.15, False)
    assert not can_use_reputation_prior(neutral, None, True)

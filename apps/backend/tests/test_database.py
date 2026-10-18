"""Unit tests for backend database layer, ORM models, and persistence."""

from datetime import datetime, timezone
import pytest
from sqlalchemy import select
from phishguard_backend.db import (
    init_db,
    async_session_maker,
    ModelReleaseRecord,
    EscalationAuditRecord,
    DomainReputationRecord,
)
from phishguard_backend.services.model_registry import model_registry


@pytest.mark.anyio
async def test_database_init_and_model_registry_sync():
    # Initialize schema
    await init_db()

    async with async_session_maker() as session:
        # Sync model releases with database
        await model_registry.sync_with_db(session)

        # Verify that seeded records exist
        stmt = select(ModelReleaseRecord)
        result = await session.execute(stmt)
        records = result.scalars().all()

        versions = [r.version for r in records]
        assert "1.0.0" in versions
        assert "1.1.0" in versions

        v11 = next(r for r in records if r.version == "1.1.0")
        assert v11.name == "phishguard-student-advanced"
        assert v11.file_size_bytes > 0
        assert "accuracy" in v11.metrics


@pytest.mark.anyio
async def test_escalation_audit_crud():
    from uuid import uuid4
    await init_db()

    telemetry_id = f"test-telemetry-{uuid4()}"
    async with async_session_maker() as session:
        audit = EscalationAuditRecord(
            telemetry_id=telemetry_id,
            url="https://phishing-site-test.com/login",
            domain="phishing-site-test.com",
            client_risk_score=0.78,
            is_phishing=True,
            target_brand="PayPal",
            action_override="BLOCK",
            explanation_reasons=["Invisible overlay element", "CrossOrigin password input"],
            teacher_model_version="multimodal-teacher-v1.0",
            created_at=datetime.now(timezone.utc),
        )
        session.add(audit)
        await session.commit()

        # Query back
        stmt = select(EscalationAuditRecord).where(
            EscalationAuditRecord.telemetry_id == telemetry_id
        )
        result = await session.execute(stmt)
        saved = result.scalar_one()

        assert saved.domain == "phishing-site-test.com"
        assert saved.is_phishing is True
        assert saved.target_brand == "PayPal"
        assert saved.action_override == "BLOCK"
        assert len(saved.explanation_reasons) == 2


@pytest.mark.anyio
async def test_domain_reputation_crud():
    from uuid import uuid4
    await init_db()

    test_domain = f"test-domain-{uuid4().hex[:8]}.com"
    async with async_session_maker() as session:
        rep = DomainReputationRecord(
            domain=test_domain,
            reputation_score=0.99,
            is_trusted=True,
            category="SEARCH_ENGINE",
            last_updated=datetime.now(timezone.utc),
        )
        session.add(rep)
        await session.commit()

        stmt = select(DomainReputationRecord).where(DomainReputationRecord.domain == test_domain)
        result = await session.execute(stmt)
        saved = result.scalar_one()

        assert saved.domain == test_domain
        assert saved.is_trusted is True
        assert saved.reputation_score == 0.99


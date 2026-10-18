"""SQLAlchemy ORM models for PostgreSQL persistence."""

from datetime import datetime, timezone
import uuid
from sqlalchemy import (
    Column,
    String,
    Integer,
    Float,
    Boolean,
    DateTime,
    Text,
    JSON,
)
from .database import Base


class ModelReleaseRecord(Base):
    """Model release checkpoints registered in PostgreSQL."""

    __tablename__ = "model_releases"

    version = Column(String(32), primary_key=True)
    name = Column(String(128), nullable=False)
    architecture = Column(String(128), nullable=False)
    sha256 = Column(String(64), nullable=False)
    file_size_bytes = Column(Integer, nullable=False)
    released_at = Column(DateTime(timezone=True), nullable=False)
    min_extension_version = Column(String(32), default="0.1.0", nullable=False)
    features = Column(JSON, default=list, nullable=False)
    metrics = Column(JSON, nullable=False)
    changelog = Column(JSON, default=list, nullable=False)
    download_url = Column(String(256), nullable=False)
    subpath = Column(String(256), nullable=False)

    def to_dict(self):
        return {
            "version": self.version,
            "name": self.name,
            "architecture": self.architecture,
            "sha256": self.sha256,
            "fileSizeBytes": self.file_size_bytes,
            "releasedAt": self.released_at,
            "minExtensionVersion": self.min_extension_version,
            "features": self.features,
            "metrics": self.metrics,
            "changelog": self.changelog,
            "downloadUrl": self.download_url,
        }


class EscalationAuditRecord(Base):
    """Forensic audit log of escalated telemetry evaluations."""

    __tablename__ = "escalation_audits"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    telemetry_id = Column(String(36), index=True, nullable=False)
    url = Column(Text, nullable=False)
    domain = Column(String(256), index=True, nullable=False)
    client_risk_score = Column(Float, nullable=False)
    is_phishing = Column(Boolean, nullable=False)
    target_brand = Column(String(128), nullable=True)
    action_override = Column(String(16), nullable=False)
    explanation_reasons = Column(JSON, default=list, nullable=False)
    teacher_model_version = Column(String(64), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class DomainReputationRecord(Base):
    """Persistent domain reputation and threat intelligence cache."""

    __tablename__ = "domain_reputations"

    domain = Column(String(256), primary_key=True)
    reputation_score = Column(Float, nullable=False)
    is_trusted = Column(Boolean, default=False, nullable=False)
    category = Column(String(64), default="UNKNOWN", nullable=False)
    last_updated = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)

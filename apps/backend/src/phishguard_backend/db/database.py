"""Database connection, engine configuration, and session management"""

import os
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
    AsyncEngine,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def get_database_url() -> str:
    """Resolve database URL with PostgreSQL preference and async SQLite fallback."""
    raw_url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")

    if raw_url:
        # Standardize postgres protocol for asyncpg
        if raw_url.startswith("postgresql+psycopg://"):
            return raw_url.replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
        if raw_url.startswith("postgresql://"):
            return raw_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        if raw_url.startswith("postgres://"):
            return raw_url.replace("postgres://", "postgresql+asyncpg://", 1)
        return raw_url

    # Default fallback to async SQLite for local offline tests / dev without Docker
    dev_db_path = os.environ.get("SQLITE_DB_PATH", "phishguard_backend.db")
    return f"sqlite+aiosqlite:///{dev_db_path}"


DATABASE_URL = get_database_url()

# Configure SQLAlchemy AsyncEngine
is_sqlite = DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if is_sqlite else {}

engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=os.environ.get("SQL_ECHO", "false").lower() == "true",
    future=True,
    connect_args=connect_args,
)

async_session_maker = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for yielding an active asynchronous database session."""
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db(max_retries: int = 5, retry_delay: float = 2.0) -> None:
    """Initialize database schema tables if they do not exist, with retry logic."""
    import asyncio
    import logging

    log = logging.getLogger(__name__)
    for attempt in range(1, max_retries + 1):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            log.info("Database schema initialized successfully.")
            return
        except Exception as exc:
            if attempt == max_retries:
                log.error("Failed to initialize database after %d attempts: %s", max_retries, exc)
                raise
            log.warning(
                "Database connection attempt %d/%d failed (%s). Retrying in %ss...",
                attempt, max_retries, exc, retry_delay
            )
            await asyncio.sleep(retry_delay)


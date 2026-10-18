-- PhishGuard Postgres bootstrap.
-- Runs once, only when the pgdata volume is first created.
-- Keep this idempotent and schema-neutral until real migrations exist.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive domain columns

-- Placeholder schema for future escalation/analytics persistence.
CREATE SCHEMA IF NOT EXISTS phishguard;
COMMENT ON SCHEMA phishguard IS 'Reserved for escalation audit + analytics tables';

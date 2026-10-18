import pytest

from phishguard_backend.services.gemini_agent import call_budget, circuit_breaker
from phishguard_backend.services.rate_limit import gemini_escalate_limiter, playground_run_limiter


@pytest.fixture(autouse=True)
def isolate_gemini(monkeypatch):
    for name in (
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GEMINI_TEACHER_ENABLED",
        "GEMINI_TEACHER_MODEL",
        "GEMINI_TEACHER_TIMEOUT_S",
        "GEMINI_TEACHER_MAX_CALLS_PER_HOUR",
    ):
        monkeypatch.delenv(name, raising=False)
    circuit_breaker.reset()
    call_budget.reset()
    gemini_escalate_limiter.reset()
    playground_run_limiter.reset()
    yield
    circuit_breaker.reset()
    call_budget.reset()
    gemini_escalate_limiter.reset()
    playground_run_limiter.reset()

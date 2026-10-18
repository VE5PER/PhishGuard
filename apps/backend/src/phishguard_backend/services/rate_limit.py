"""In-memory sliding-window rate limiter keyed by client address."""

import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import HTTPException, Request, status


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


class SlidingWindowRateLimiter:
    """Per-key request cap over a sliding window.

    State lives in process memory, so this relies on the single-worker
    deployment (one uvicorn worker, one Cloud Run instance per limiter).
    """

    def __init__(self, limit: int, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def reset(self) -> None:
        self._hits.clear()

    def check(self, key: str) -> None:
        now = self._clock()
        hits = self._hits[key]
        while hits and now - hits[0] >= self.window_s:
            hits.popleft()
        if len(hits) >= self.limit:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Rate limit exceeded; retry shortly")
        hits.append(now)

    def enforce(self, request: Request) -> None:
        self.check(client_key(request))


playground_run_limiter = SlidingWindowRateLimiter(limit=12)
gemini_escalate_limiter = SlidingWindowRateLimiter(limit=20)

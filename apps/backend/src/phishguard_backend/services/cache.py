"""Domain reputation and deduplication cache service."""

from typing import Any, Dict, Optional
import time


class ReputationCacheService:
    """In-memory reputation & deduplication cache (Redis interface skeleton)."""

    def __init__(self, default_ttl_sec: int = 3600):
        self.default_ttl = default_ttl_sec
        self._verdicts: Dict[str, Dict[str, Any]] = {}
        self._priors: Dict[str, Dict[str, Any]] = {}
        self._seed_known_domains()

    def _normalize_hostname(self, hostname: str) -> str:
        return str(hostname).rstrip(".").encode("idna").decode("ascii").lower()

    def _seed_known_domains(self) -> None:
        # Seed known benign domains for zero-latency pass-through
        for hostname in ("google.com", "microsoft.com", "apple.com", "github.com", "amazon.com"):
            self._priors[self._normalize_hostname(hostname)] = {
                "is_phishing": False,
                "confidence": 0.99,
                "target_brand": None,
                "action": "ALLOW",
                "reasons": ["Known high-reputation domain"],
                "expires_at": time.time() + 86400 * 30,
            }

    def get_reputation_prior(self, hostname: str) -> Optional[Dict[str, Any]]:
        key = self._normalize_hostname(hostname)
        entry = self._priors.get(key)
        if not entry:
            return None
        if time.time() > entry.get("expires_at", 0):
            del self._priors[key]
            return None
        return entry

    def set_reputation_prior(
        self,
        hostname: str,
        is_phishing: bool,
        confidence: float,
        target_brand: Optional[str],
        action: str,
        reasons: list[str],
        ttl_sec: Optional[int] = None,
    ) -> None:
        key = self._normalize_hostname(hostname)
        self._priors[key] = {
            "is_phishing": is_phishing,
            "confidence": confidence,
            "target_brand": target_brand,
            "action": action,
            "reasons": reasons,
            "expires_at": time.time() + (ttl_sec or self.default_ttl),
        }

    def get_verdict(self, cache_key: str) -> Optional[Dict[str, Any]]:
        entry = self._verdicts.get(cache_key)
        if not entry:
            return None
        if time.time() > entry.get("expires_at", 0):
            del self._verdicts[cache_key]
            return None
        return entry

    def set_verdict(
        self,
        cache_key: str,
        is_phishing: bool,
        confidence: float,
        target_brand: Optional[str],
        action: str,
        reasons: list[str],
        ttl_sec: Optional[int] = None,
        teacher_model_version: str = "cloud-evidence-v2",
        risk_score: Optional[float] = None,
        screen_analysis: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._verdicts[cache_key] = {
            "is_phishing": is_phishing,
            "confidence": confidence,
            "target_brand": target_brand,
            "action": action,
            "reasons": reasons,
            "teacher_model_version": teacher_model_version,
            "risk_score": risk_score,
            "screen_analysis": screen_analysis,
            "expires_at": time.time() + (ttl_sec or self.default_ttl),
        }

    def clear(self) -> None:
        self._verdicts.clear()
        self._priors.clear()
        self._seed_known_domains()


reputation_cache = ReputationCacheService()

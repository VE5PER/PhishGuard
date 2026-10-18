"""Heuristic dataset labeling and brand identity consistency verification."""

import re
from typing import Optional, Tuple
from phishguard_ml_engine.data.feature_extractor import (
    is_official_domain_for_brand,
    BRAND_LEGITIMATE_DOMAINS,
)
from phishguard_ml_engine.data.industrial_benchmark_dataset import INDUSTRIAL_PHISHING_RECORDS
from .models import FetchedPageMetadata

SUSPICIOUS_TLDS = {
    "xyz", "top", "club", "live", "work", "buzz", "tk", "ml", "ga", "cf",
    "gq", "icu", "cam", "fit", "surf", "rest", "bar", "security",
}

CREDENTIAL_KEYWORDS = [
    "login", "signin", "sign-in", "verify", "auth", "oauth", "password",
    "checkpoint", "security", "portal", "account", "update", "banking",
]


class HeuristicDatasetLabeler:
    """Evaluates candidate page metadata to assign training ground truth labels."""

    @staticmethod
    def is_known_threat(url: str, domain: str) -> bool:
        """Check if URL or domain is an existing benchmark threat record."""
        clean_url = url.lower()
        clean_domain = domain.lower()
        for rec in INDUSTRIAL_PHISHING_RECORDS:
            if rec["url"].lower() == clean_url or rec["domain"].lower() == clean_domain:
                return True
        return False

    def label_candidate(
        self,
        meta: FetchedPageMetadata,
        target_brand: Optional[str] = None,
        search_intent: str = "phishing_discovery",
    ) -> Tuple[float, float, str]:
        """Assign ground-truth label, confidence score, and rationale.

        Returns:
            (label, confidence, reason)
            label: 0.0 for Benign, 1.0 for Phishing
        """
        domain = meta.domain.lower()
        if meta.fetch_error or meta.status_code == 0:
            return 0.5, 0.0, "Page unavailable; training label withheld"

        # 1. Known threat feed check
        if self.is_known_threat(meta.url, domain):
            return 1.0, 0.99, "Repository synthetic benchmark record match; not live threat verification"

        # 2. Official brand domain check
        if target_brand:
            if is_official_domain_for_brand(domain, target_brand):
                return 0.0, 0.99, f"Official domain for target brand '{target_brand}'"

        # Check if domain is an official domain for ANY brand in the registry
        for brand, legit_domains in BRAND_LEGITIMATE_DOMAINS.items():
            for l_dom in legit_domains:
                if domain == l_dom or domain.endswith("." + l_dom):
                    return 0.0, 0.98, f"Matches official registry for '{brand}'"

        # 3. Phishing heuristic signals
        tld = domain.split(".")[-1] if "." in domain else ""
        is_suspicious_tld = tld in SUSPICIOUS_TLDS

        # Brand impersonation detection in domain/path
        brand_impersonation = False
        if target_brand:
            brand_token = target_brand.lower().replace(" ", "")
            if brand_token in domain and not is_official_domain_for_brand(domain, target_brand):
                brand_impersonation = True

        # Credential harvesting indicators
        url_lower = meta.url.lower()
        cred_keyword_matches = [kw for kw in CREDENTIAL_KEYWORDS if kw in url_lower]
        has_credential_intent = len(cred_keyword_matches) > 0 or meta.has_login_form or meta.password_inputs_count > 0

        # IP address host detection
        is_ip_host = bool(re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", domain))

        phishing_score = 0.0
        reasons = []

        if brand_impersonation:
            phishing_score += 0.50
            reasons.append(f"Target brand '{target_brand}' in unauthorized domain")

        if is_ip_host:
            phishing_score += 0.40
            reasons.append("Raw IP address host")

        if is_suspicious_tld:
            phishing_score += 0.25
            reasons.append(f"Abused TLD .{tld}")

        if has_credential_intent and (brand_impersonation or is_suspicious_tld or is_ip_host):
            phishing_score += 0.35
            reasons.append("Credential harvest keywords/forms on suspicious host")

        if search_intent == "phishing_discovery" and brand_impersonation and has_credential_intent:
            return 1.0, 0.95, "; ".join(reasons)

        if phishing_score >= 0.50:
            return 1.0, min(0.95, 0.70 + phishing_score * 0.25), "; ".join(reasons)

        # Default to benign for benign queries or benign web anchors
        if search_intent == "benign_anchor":
            return 0.0, 0.90, "Legitimate web anchor without impersonation signals"

        # Ambiguous/neutral: classify based on score threshold
        final_label = 1.0 if phishing_score >= 0.40 else 0.0
        final_conf = 0.80
        reason_str = "; ".join(reasons) if reasons else "Heuristic baseline classification"
        return final_label, final_conf, reason_str

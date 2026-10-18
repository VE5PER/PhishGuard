"""Query generator for discovering phishing and benign candidate pages via web search."""

from typing import List, Optional
import random

from phishguard_ml_engine.data.feature_extractor import BRAND_LEGITIMATE_DOMAINS
from .models import SearchQuery


PHISHING_TEMPLATES: List[str] = [
    '"{brand}" login account verify prompt',
    '"{brand}" sign in session authentication expired',
    '"{brand}" security alert update billing payment',
    '"{brand}" password reset authorization checkpoint',
    '"{brand}" shared document urgent access review',
    '"{brand}" mobile verification code secure signon',
    '"{brand}" customer support portal unlock account',
    '"{brand}" invoice confirmation statement view online',
]

BENIGN_TEMPLATES: List[str] = [
    '"{brand}" official website login portal',
    '"{brand}" help center customer security guidelines',
    '"{brand}" documentation overview products services',
    '"{brand}" developer api documentation authenticate',
]


class DatasetQueryGenerator:
    """Generates search queries for daily threat exploration and benign dataset balance."""

    def __init__(self, target_brands: Optional[List[str]] = None, seed: Optional[int] = None):
        self.target_brands = target_brands or list(BRAND_LEGITIMATE_DOMAINS.keys())
        self._rng = random.Random(seed)

    def generate_phishing_discovery_queries(
        self,
        count_per_brand: int = 2,
        max_results_per_query: int = 10,
    ) -> List[SearchQuery]:
        """Generate targeted search queries to discover emerging phishing lures."""
        queries: List[SearchQuery] = []
        for brand in self.target_brands:
            templates = self._rng.sample(PHISHING_TEMPLATES, min(count_per_brand, len(PHISHING_TEMPLATES)))
            legit_domain = BRAND_LEGITIMATE_DOMAINS.get(brand, [None])[0]
            for tmpl in templates:
                q_text = tmpl.format(brand=brand)
                if legit_domain and self._rng.random() < 0.3:
                    # In 30% of dorks, negate the official primary domain to find off-domain lures
                    q_text = f"{q_text} -site:{legit_domain}"
                queries.append(
                    SearchQuery(
                        query_text=q_text,
                        target_brand=brand,
                        intent="phishing_discovery",
                        max_results=max_results_per_query,
                    )
                )
        return queries

    def generate_benign_anchor_queries(
        self,
        count_per_brand: int = 1,
        max_results_per_query: int = 10,
    ) -> List[SearchQuery]:
        """Generate search queries for legitimate baseline brand sites."""
        queries: List[SearchQuery] = []
        for brand in self.target_brands:
            templates = self._rng.sample(BENIGN_TEMPLATES, min(count_per_brand, len(BENIGN_TEMPLATES)))
            for tmpl in templates:
                q_text = tmpl.format(brand=brand)
                queries.append(
                    SearchQuery(
                        query_text=q_text,
                        target_brand=brand,
                        intent="benign_anchor",
                        max_results=max_results_per_query,
                    )
                )
        return queries

    def generate_daily_query_batch(
        self,
        phishing_ratio: float = 0.6,
        total_queries: int = 20,
        max_results_per_query: int = 10,
    ) -> List[SearchQuery]:
        """Generate a complete balanced batch of search queries for a daily agent run."""
        num_phish = max(1, int(total_queries * phishing_ratio))
        num_benign = max(1, total_queries - num_phish)

        phish_per_brand = max(1, (num_phish // len(self.target_brands)) + 1)
        benign_per_brand = max(1, (num_benign // len(self.target_brands)) + 1)

        phish_queries = self.generate_phishing_discovery_queries(
            count_per_brand=phish_per_brand,
            max_results_per_query=max_results_per_query,
        )
        benign_queries = self.generate_benign_anchor_queries(
            count_per_brand=benign_per_brand,
            max_results_per_query=max_results_per_query,
        )

        self._rng.shuffle(phish_queries)
        self._rng.shuffle(benign_queries)

        selected = phish_queries[:num_phish] + benign_queries[:num_benign]
        self._rng.shuffle(selected)
        return selected

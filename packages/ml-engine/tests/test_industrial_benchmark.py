"""Unit tests for Industrial Benchmark Dataset ingestion and feature representations."""

import numpy as np
import pytest

from phishguard_ml_engine.data.industrial_benchmark_dataset import (
    INDUSTRIAL_PHISHING_RECORDS,
    INDUSTRIAL_BENIGN_RECORDS,
    PHISHPEDIA_TARGET_BRANDS,
    build_industrial_benchmark_dataset,
)
from phishguard_ml_engine.data.feature_extractor import (
    extract_url_features,
    extract_logo_features,
    is_official_domain_for_brand,
)


def test_industrial_dataset_feed_constants():
    """Verify that industrial threat feed and benign benchmark records are populated."""
    assert len(INDUSTRIAL_PHISHING_RECORDS) >= 15
    assert len(INDUSTRIAL_BENIGN_RECORDS) >= 10
    assert len(PHISHPEDIA_TARGET_BRANDS) >= 15

    # Ensure all phishing records contain required fields
    for rec in INDUSTRIAL_PHISHING_RECORDS:
        assert "url" in rec
        assert "brand" in rec
        assert "domain" in rec
        assert rec["url"].startswith("http")

    # Ensure all benign records are valid
    for rec in INDUSTRIAL_BENIGN_RECORDS:
        assert "url" in rec
        assert "brand" in rec
        assert "domain" in rec
        assert rec["url"].startswith("http")


def test_phishpedia_brand_consistency_heuristics():
    """Verify official domain vs phishing domain consistency for Phishpedia targets."""
    # Microsoft legitimate domain
    assert is_official_domain_for_brand("microsoft.com", "microsoft") is True
    assert is_official_domain_for_brand("login.live.com", "microsoft") is True
    # Microsoft phishing spoof domain
    assert is_official_domain_for_brand("microsoft.account-verify.xyz", "microsoft") is False

    # Google legitimate vs spoof
    assert is_official_domain_for_brand("accounts.google.com", "google") is True
    assert is_official_domain_for_brand("google-security-auth.net", "google") is False

    # PayPal legitimate vs spoof
    assert is_official_domain_for_brand("paypal.com", "paypal") is True
    assert is_official_domain_for_brand("paypal.security-center-update.com", "paypal") is False


def test_build_industrial_benchmark_dataset_generation():
    """Verify building industrial benchmark dataset produces valid multimodal samples."""
    samples = build_industrial_benchmark_dataset(
        num_samples=20,
        phishing_ratio=0.5,
        seq_length=32,
        seed=123,
    )

    assert len(samples) == 20

    phishing_count = sum(1 for s in samples if s["isPhishing"])
    benign_count = sum(1 for s in samples if not s["isPhishing"])
    assert phishing_count > 0
    assert benign_count > 0

    for s in samples:
        # Check URL features
        assert "extractedFeatures" in s
        assert len(s["extractedFeatures"]["url"]) == 32

        # Check dynamics series
        assert "pointerSeries" in s
        assert len(s["pointerSeries"]) == 32

        # Check logo grounding if present
        if s.get("logoDetections"):
            for logo_g in s["logoDetections"]:
                assert logo_g["brandName"].lower() in [b.lower() for b in PHISHPEDIA_TARGET_BRANDS]
                assert 0.0 <= logo_g["confidence"] <= 1.0

            logo_feat = extract_logo_features(s["logoDetections"], domain=s["domain"])
            assert logo_feat.shape == (16,)
            if s["isPhishing"] and not is_official_domain_for_brand(s["domain"], s["logoDetections"][0]["brandName"]):
                # Brand mismatch should be flagged in logo feature dimension 15
                assert logo_feat[15] == 1.0

        # Check detection annotations if present
        if s.get("imageDetections"):
            for det in s["imageDetections"]:
                assert det["category"] in ["input_credential", "button_submit", "security_badge", "login_card", "input_generic"]


def test_industrial_url_and_logo_feature_distinction():
    """Ensure URL and Logo features strongly differentiate industrial phishing from benign."""
    # Microsoft phishing sample from PhishTank
    phish_url = "http://login-microsoft-auth.xyz/office365/login"
    phish_domain = "login-microsoft-auth.xyz"
    p_url_feat = extract_url_features(phish_url, domain=phish_domain)

    # Legitimate Microsoft URL
    benign_url = "https://login.microsoftonline.com/common/oauth2/authorize"
    benign_domain = "login.microsoftonline.com"
    b_url_feat = extract_url_features(benign_url, domain=benign_domain)

    # Phishing URL should have high mismatch risk and suspicious TLD
    assert p_url_feat[12] == 1.0  # .xyz
    assert p_url_feat[31] >= 0.75 # brand mismatch risk
    assert b_url_feat[12] == 0.0  # .com
    assert b_url_feat[31] == 0.0  # legitimate brand domain

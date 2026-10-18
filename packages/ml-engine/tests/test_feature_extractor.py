"""Unit tests for Multimodal Feature Extractor across URL, HID, Logo, Screen, and Detection."""

import numpy as np
import pytest

from phishguard_ml_engine.data import (
    extract_url_features,
    extract_hid_features,
    extract_logo_features,
    extract_image_detection_features,
    is_official_domain_for_brand,
    generate_multimodal_sample,
    generate_multimodal_dataset_batch,
)


def test_url_feature_extraction_benign_vs_phishing():
    # Benign URL
    benign_url = "https://en.wikipedia.org/wiki/Computer_security"
    b_feat = extract_url_features(benign_url, domain="en.wikipedia.org")
    assert isinstance(b_feat, np.ndarray)
    assert b_feat.shape == (32,)
    assert b_feat.dtype == np.float32
    assert b_feat[10] == 0.0  # not an IP address
    assert b_feat[11] == 1.0  # HTTPS present
    assert b_feat[12] == 0.0  # not suspicious TLD
    assert b_feat[31] == 0.0  # no brand mismatch risk

    # Phishing URL (subdomain spoofing with suspicious TLD and keywords)
    phish_url = "https://microsoft.com.account-update.xyz/login/verify?session=abc"
    p_feat = extract_url_features(phish_url, domain="microsoft.com.account-update.xyz")
    assert p_feat.shape == (32,)
    assert p_feat[12] == 1.0  # .xyz is in suspicious TLDs
    assert p_feat[13] > 0.0   # sensitive keywords ('account', 'update', 'login', 'verify')
    assert p_feat[14] == 1.0  # 'microsoft' in subdomain
    assert p_feat[31] >= 0.75 # high brand mismatch risk

    # IP address based URL
    ip_url = "http://192.168.1.10/login"
    ip_feat = extract_url_features(ip_url, domain="192.168.1.10")
    assert ip_feat[10] == 1.0  # IP address detected
    assert ip_feat[11] == 0.0  # not HTTPS


def test_hid_feature_extraction():
    # Normal human pointer events
    pointer_events = [
        {"x": 0.1, "y": 0.1, "velocity": 0.2, "acceleration": 0.01, "angle": 0.1, "timestamp": 10.0},
        {"x": 0.2, "y": 0.25, "velocity": 0.4, "acceleration": 0.02, "angle": 0.3, "timestamp": 30.0},
        {"x": 0.35, "y": 0.4, "velocity": 0.3, "acceleration": -0.01, "angle": 0.2, "timestamp": 60.0},
    ]
    keystrokes = [
        {"category": "ALPHANUMERIC", "dwellTimeMs": 80.0, "flightTimeMs": 110.0, "timestamp": 100.0},
        {"category": "ALPHANUMERIC", "dwellTimeMs": 85.0, "flightTimeMs": 120.0, "timestamp": 300.0},
    ]
    dom_events = [
        {"eventType": "click", "isZeroOpacity": False, "isCrossOriginIframe": False, "isPasteIntoPassword": False, "timestamp": 400.0}
    ]

    h_feat = extract_hid_features(pointer_events, keystrokes, dom_events)
    assert isinstance(h_feat, np.ndarray)
    assert h_feat.shape == (16,)
    assert h_feat[10] == 0.0  # no paste into password
    assert h_feat[11] == 0.0  # no zero opacity click
    assert h_feat[12] == 0.0  # no cross-origin iframe

    # Suspicious interaction with paste and zero opacity
    suspicious_dom = [
        {"eventType": "paste", "isZeroOpacity": True, "isCrossOriginIframe": True, "isPasteIntoPassword": True, "timestamp": 500.0}
    ]
    s_feat = extract_hid_features(pointer_events, keystrokes, suspicious_dom)
    assert s_feat[10] == 1.0  # paste into password flagged
    assert s_feat[11] == 1.0  # zero opacity flagged
    assert s_feat[12] == 1.0  # cross origin flagged
    assert s_feat[15] > 0.5   # high anomaly score


def test_logo_feature_extraction_and_domain_mismatch():
    # Official brand domain check
    assert is_official_domain_for_brand("Microsoft", "login.microsoftonline.com") is True
    assert is_official_domain_for_brand("Microsoft", "evil-phish.xyz") is False
    assert is_official_domain_for_brand("PayPal", "paypal.com") is True
    assert is_official_domain_for_brand("PayPal", "paypal-security.net") is False

    # Authentic logo detection on official domain
    auth_logos = [{
        "brandName": "Microsoft",
        "brandId": 0,
        "confidence": 0.98,
        "boundingBox": {"x": 0.05, "y": 0.02, "width": 0.15, "height": 0.06},
    }]
    auth_feat = extract_logo_features(auth_logos, domain="login.microsoftonline.com")
    assert auth_feat.shape == (16,)
    assert auth_feat[0] == 1.0  # logo detected
    assert auth_feat[3] == 0.0  # NO brand-domain mismatch
    assert auth_feat[13] == 1.0 # domain is official

    # Spoofed logo detection on phishing domain
    spoofed_logos = [{
        "brandName": "Microsoft",
        "brandId": 0,
        "confidence": 0.98,
        "boundingBox": {"x": 0.20, "y": 0.15, "width": 0.25, "height": 0.08},
    }]
    spoof_feat = extract_logo_features(spoofed_logos, domain="microsoft-auth.xyz")
    assert spoof_feat[3] == 1.0   # BRAND-DOMAIN MISMATCH DETECTED!
    assert spoof_feat[13] == 0.0  # not official
    assert spoof_feat[15] == 1.0  # high logo composite risk


def test_image_detection_feature_extraction():
    detections = [
        {"category": "input_credential", "confidence": 0.95, "boundingBox": {"x": 0.2, "y": 0.35, "width": 0.6, "height": 0.08}},
        {"category": "input_credential", "confidence": 0.96, "boundingBox": {"x": 0.2, "y": 0.45, "width": 0.6, "height": 0.08}},
        {"category": "button_submit", "confidence": 0.98, "boundingBox": {"x": 0.2, "y": 0.58, "width": 0.6, "height": 0.08}},
        {"category": "security_badge", "confidence": 0.90, "boundingBox": {"x": 0.3, "y": 0.70, "width": 0.4, "height": 0.05}},
    ]
    det_feat = extract_image_detection_features(detections)
    assert isinstance(det_feat, np.ndarray)
    assert det_feat.shape == (16,)
    assert det_feat[4] == 1.0   # login form detected (inputs + submit button)
    assert det_feat[10] == 1.0  # fake security badge detected
    assert det_feat[15] > 0.5   # high credential harvesting risk


def test_multimodal_generator_batch():
    batch = generate_multimodal_dataset_batch(num_samples=10, phishing_ratio=0.5, seed=123)
    assert len(batch) == 10
    labels = [s["label"] for s in batch]
    assert labels.count(1.0) == 5
    assert labels.count(0.0) == 5

    # Verify each sample contains all 5 modalities
    for s in batch:
        assert "url" in s and len(s["url"]) > 0
        assert "domain" in s and len(s["domain"]) > 0
        assert "pointerSeries" in s and len(s["pointerSeries"]) == 64
        assert "viewport" in s and s["viewport"].shape == (224, 224, 3)
        assert "extractedFeatures" in s
        ef = s["extractedFeatures"]
        assert len(ef["url"]) == 32
        assert len(ef["hid"]) == 16
        assert len(ef["logo"]) == 16
        assert len(ef["detection"]) == 16

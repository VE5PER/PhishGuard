"""Tests for page fetching, heuristic labeling, and multimodal sample construction."""

import pytest
import httpx
from phishguard_types import MultimodalDatasetSample, TargetBrandClass
from phishguard_dataset_agent.collector.models import FetchedPageMetadata
from phishguard_dataset_agent.collector import page_fetcher as page_fetcher_module
from phishguard_dataset_agent.collector.page_fetcher import PageFetcher
from phishguard_dataset_agent.collector.labeler import HeuristicDatasetLabeler
from phishguard_dataset_agent.collector.sample_builder import DatasetSampleBuilder


def test_page_fetcher_domain_extraction():
    assert PageFetcher.extract_domain("https://www.microsoft.com/en-us/login") == "www.microsoft.com"
    assert PageFetcher.extract_domain("http://login.paypal.verify-auth.xyz/checkpoint") == "login.paypal.verify-auth.xyz"
    assert PageFetcher.extract_domain("http://192.168.1.1:8080/auth") == "192.168.1.1"


def test_page_fetcher_safe_fallback_on_unreachable(monkeypatch):
    import asyncio

    class UnreachableClient:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **_kwargs):
            raise httpx.ConnectError("isolated offline fixture", request=httpx.Request("GET", url))

    monkeypatch.setattr(page_fetcher_module.httpx, "AsyncClient", UnreachableClient)

    async def _run():
        fetcher = PageFetcher(timeout=1.0)
        meta = await fetcher.fetch("http://invalid-non-existent-domain-123456789.xyz/login")
        assert isinstance(meta, FetchedPageMetadata)
        assert meta.domain == "invalid-non-existent-domain-123456789.xyz"
        assert meta.fetch_error is not None
    asyncio.run(_run())


def test_heuristic_labeler_official_domain():
    labeler = HeuristicDatasetLabeler()
    meta = FetchedPageMetadata(
        url="https://login.microsoftonline.com/auth",
        final_url="https://login.microsoftonline.com/auth",
        domain="login.microsoftonline.com",
        title="Sign in to your account",
        has_login_form=True,
    )
    label, conf, reason = labeler.label_candidate(meta, target_brand="Microsoft", search_intent="benign_anchor")
    assert label == 0.0
    assert conf >= 0.90
    assert "Official" in reason or "official" in reason


def test_heuristic_labeler_suspicious_phishing_spoof():
    labeler = HeuristicDatasetLabeler()
    meta = FetchedPageMetadata(
        url="http://login-microsoft-verify-session.xyz/signin",
        final_url="http://login-microsoft-verify-session.xyz/signin",
        domain="login-microsoft-verify-session.xyz",
        title="Microsoft Security Alert - Sign In",
        has_login_form=True,
        password_inputs_count=1,
    )
    label, conf, reason = labeler.label_candidate(meta, target_brand="Microsoft", search_intent="phishing_discovery")
    assert label == 1.0
    assert conf >= 0.80


def test_sample_builder_multimodal_schema_parity():
    builder = DatasetSampleBuilder(seed=42)
    meta = FetchedPageMetadata(
        url="https://login.microsoft.security-portal.xyz/checkpoint",
        final_url="https://login.microsoft.security-portal.xyz/checkpoint",
        domain="security-portal.xyz",
        title="Microsoft Login",
        has_login_form=True,
        password_inputs_count=1,
    )

    sample = builder.build_sample(
        meta=meta,
        label=1.0,
        target_brand_name="Microsoft",
        seq_length=64,
    )

    # Validate against strict Pydantic v2 schema
    assert isinstance(sample, MultimodalDatasetSample)
    assert sample.label == 1.0
    assert sample.targetBrand == TargetBrandClass.MICROSOFT
    assert len(sample.pointerSeries) == 64
    assert len(sample.keystrokes) > 0
    assert sample.viewportCapture is None
    assert sample.logoDetections == []
    assert sample.imageDetections == []
    assert sample.provenance is not None
    assert sample.provenance.modalities["visual"] == "missing"
    assert sample.provenance.modalities["logo"] == "missing"

    # Privacy verification: zero raw keystroke text captured
    for ks in sample.keystrokes:
        assert hasattr(ks, "flightTimeMs")
        assert hasattr(ks, "dwellTimeMs")
        assert hasattr(ks, "category")
        # Ensure raw characters are NOT present
        assert not hasattr(ks, "key")
        assert not hasattr(ks, "character")
        assert not hasattr(ks, "raw")

    # Modality feature vector dimensionalities
    feats = sample.extractedFeatures
    assert feats is not None
    assert len(feats["url"]) == 32
    assert len(feats["hid"]) == 16
    assert len(feats["logo"]) == 16
    assert len(feats["detection"]) == 16

    # Test conversion to storage dict
    storage_dict = builder.to_storage_dict(sample)
    assert storage_dict["sampleId"] == str(sample.sampleId)
    assert storage_dict["label"] == 1.0
    assert "pointerSeries" in storage_dict

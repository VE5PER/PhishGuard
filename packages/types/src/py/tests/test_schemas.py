"""Unit tests for PhishGuard Pydantic v2 data models."""

from datetime import datetime, timezone
from uuid import uuid4
import pytest
from pydantic import ValidationError

from phishguard_types import (
    PointerEventType,
    PointerEventPoint,
    KeystrokeCategory,
    KeystrokeDynamics,
    DOMInteractionType,
    DOMEvidenceSource,
    CoveredControlType,
    CredentialFrameEvidence,
    ElementBoundingBox,
    DOMInteractionEvent,
    ScrollOffset,
    ViewportCaptureSpec,
    InteractionTelemetryPayload,
    TriStateAction,
    ClientInferenceResult,
    EscalationPayload,
    CloudActionOverride,
    CloudInferenceVerdict,
    PlaygroundScenario,
    PlaygroundScenarioList,
    PlaygroundRunRequest,
    PlaygroundInteraction,
    PlaygroundRunResponse,
    TeacherToolCall,
    TeacherTrace,
    TeacherTraceStatus,
)


def test_pointer_event_point_valid():
    point = PointerEventPoint(
        x=0.45,
        y=0.72,
        dx=3.5,
        dy=-1.2,
        velocity=0.38,
        acceleration=0.02,
        angle=-0.33,
        timestamp=120.0,
        eventType=PointerEventType.MOVE,
    )
    assert point.x == 0.45
    assert point.eventType == PointerEventType.MOVE


def test_pointer_event_point_bounds_check():
    with pytest.raises(ValidationError):
        PointerEventPoint(
            x=1.25,  # out of [0, 1] range
            y=0.5,
            dx=0.0,
            dy=0.0,
            velocity=0.0,
            acceleration=0.0,
            angle=0.0,
            timestamp=0.0,
            eventType=PointerEventType.MOVE,
        )

def test_dom_interaction_evidence_defaults_and_values():
    event = DOMInteractionEvent(
        eventType=DOMInteractionType.CLICK,
        targetBoundingBox=ElementBoundingBox(x=1, y=2, width=30, height=20),
        isZeroOpacity=False,
        isCrossOriginIframe=False,
        isPasswordInput=False,
        isPasteIntoPassword=False,
        elementSelector="form > input",
        timestamp=10.0,
    )
    assert event.evidenceSource == DOMEvidenceSource.LEGACY
    assert event.evidenceId is None
    assert event.isHitTestIntercepting is False
    assert event.coveredControlType == CoveredControlType.NONE
    assert event.credentialFrameEvidence == CredentialFrameEvidence.NONE
    assert DOMInteractionEvent(
        eventType=DOMInteractionType.CLICK,
        targetBoundingBox=ElementBoundingBox(x=1, y=2, width=30, height=20),
        isZeroOpacity=False,
        isCrossOriginIframe=False,
        isPasswordInput=False,
        isPasteIntoPassword=False,
        elementSelector="form > input",
        timestamp=10.0,
        evidenceId=None,
    ).evidenceId is None

    observed = DOMInteractionEvent(
        eventType=DOMInteractionType.CLICK,
        targetBoundingBox=ElementBoundingBox(x=1, y=2, width=30, height=20),
        isZeroOpacity=True,
        isCrossOriginIframe=False,
        isPasswordInput=False,
        isPasteIntoPassword=False,
        elementSelector="form > button",
        timestamp=10.0,
        evidenceSource=DOMEvidenceSource.TOPOLOGY_SCAN,
        evidenceId="doc1-element2",
        isHitTestIntercepting=True,
        coveredControlType=CoveredControlType.SUBMIT,
        credentialFrameEvidence=CredentialFrameEvidence.UNVERIFIED,
    )
    assert observed.evidenceSource == DOMEvidenceSource.TOPOLOGY_SCAN
    assert observed.coveredControlType == CoveredControlType.SUBMIT
    with pytest.raises(ValidationError):
        DOMInteractionEvent(
            eventType=DOMInteractionType.CLICK,
            targetBoundingBox=ElementBoundingBox(x=1, y=2, width=30, height=20),
            isZeroOpacity=False,
            isCrossOriginIframe=False,
            isPasswordInput=False,
            isPasteIntoPassword=False,
            elementSelector="button",
            timestamp=10.0,
            rawText="sensitive",
        )


def test_telemetry_nested_schemas_reject_nonfinite_values_and_extra_fields():
    with pytest.raises(ValidationError):
        PointerEventPoint(
            x=0.5,
            y=0.5,
            dx=float("inf"),
            dy=0.0,
            velocity=0.0,
            acceleration=0.0,
            angle=0.0,
            timestamp=0.0,
            eventType=PointerEventType.MOVE,
        )
    with pytest.raises(ValidationError):
        ElementBoundingBox(x=float("nan"), y=0.0, width=10.0, height=10.0)
    with pytest.raises(ValidationError):
        ScrollOffset(x=0.0, y=1.0, private_value="not allowed")
    assert ScrollOffset().model_dump() == {"x": 0.0, "y": 0.0}
    capture = ViewportCaptureSpec(
        width=64,
        height=64,
        mimeType="image/webp",
        base64Data="AA==",
        capturedAt=10.0,
    )
    assert capture.scrollOffset.model_dump() == {"x": 0.0, "y": 0.0}
    with pytest.raises(ValidationError):
        DOMInteractionEvent(
            eventType=DOMInteractionType.CLICK,
            targetBoundingBox=ElementBoundingBox(x=0, y=0, width=10, height=10),
            isZeroOpacity=False,
            isCrossOriginIframe=False,
            isPasswordInput=False,
            isPasteIntoPassword=False,
            elementSelector="button",
            timestamp=float("inf"),
        )


def test_keystroke_dynamics_gdpr_safe():
    ks = KeystrokeDynamics(
        category=KeystrokeCategory.ALPHANUMERIC,
        dwellTimeMs=75.0,
        flightTimeMs=120.0,
        timestamp=450.0,
    )
    assert ks.category == KeystrokeCategory.ALPHANUMERIC
    # Ensure extra fields (like raw text/character) are rejected
    with pytest.raises(ValidationError):
        KeystrokeDynamics(
            category=KeystrokeCategory.ALPHANUMERIC,
            dwellTimeMs=75.0,
            flightTimeMs=120.0,
            timestamp=450.0,
            rawChar="A",  # Forbidden extra field
        )


def test_escalation_payload_and_verdict_parity():
    telem_id = uuid4()
    escalation = EscalationPayload(
        telemetryId=telem_id,
        url="https://secure-login.example.com/auth",
        domain="secure-login.example.com",
        clientRiskScore=0.72,
        mouseTrajectorySeries=[
            PointerEventPoint(
                x=0.1,
                y=0.2,
                dx=1.0,
                dy=0.5,
                velocity=0.2,
                acceleration=0.01,
                angle=0.46,
                timestamp=10.0,
                eventType=PointerEventType.MOVE,
            )
        ],
        domElementsSummary=[
            DOMInteractionEvent(
                eventType=DOMInteractionType.CLICK,
                targetBoundingBox=ElementBoundingBox(x=10, y=20, width=100, height=30),
                isZeroOpacity=False,
                isCrossOriginIframe=True,
                isPasswordInput=True,
                isPasteIntoPassword=False,
                elementSelector="form > input#pass",
                timestamp=500.0,
            )
        ],
        clientTimestamp=datetime.now(timezone.utc),
    )
    assert escalation.clientRiskScore == 0.72
    assert escalation.hasCredentialField is False
    optional_client_fields = EscalationPayload(
        telemetryId=telem_id,
        url="https://secure-login.example.com/auth",
        domain="secure-login.example.com",
        clientRiskScore=0.72,
        hasCredentialField=False,
        clientModelVersion=None,
        clientModelSha256=None,
        clientInputContract=None,
        clientTimestamp=datetime.now(timezone.utc),
    )
    assert optional_client_fields.clientModelVersion is None
    assert optional_client_fields.mouseTrajectorySeries == []
    assert optional_client_fields.domElementsSummary == []
    assert optional_client_fields.keystrokesSummary == []

    verdict = CloudInferenceVerdict(
        analysisId=uuid4(),
        telemetryId=telem_id,
        isPhishing=True,
        targetBrand="Microsoft",
        confidence=0.96,
        actionOverride=CloudActionOverride.BLOCK,
        explanationReasons=["Cross-origin iframe password submission on untrusted domain"],
        teacherModelVersion="teacher-v1.0",
        evaluatedAt=datetime.now(timezone.utc),
    )
    assert verdict.isPhishing is True
    assert verdict.confidence == 0.96


def test_model_metadata_and_sync_status():
    from phishguard_types import (
        ModelMetrics,
        ModelInputTensor,
        ModelInputContract,
        ModelValidationSummary,
        ModelMetadata,
        ModelSyncState,
        ModelSource,
        ModelSyncStatus,
        CheckUpdateRequest,
    )

    input_contract = ModelInputContract(
        identifier="student-v2",
        trajectoryPreprocessing="trajectory-v2",
        inputs=[
            ModelInputTensor(name="trajectory", dtype="float32", shape=[1, 128, 6]),
            ModelInputTensor(name="visual", dtype="float32", shape=[1, 3, 64, 64]),
            ModelInputTensor(name="page_context", dtype="float32", shape=[1, 16]),
        ],
        contextFeatures=["url_userinfo", "https"],
    )
    validation_summary = ModelValidationSummary(
        passedAllGates=False,
        modelSha256="0" * 64,
        corpusDigest="1" * 64,
        reportSha256="2" * 64,
        inputContractIdentifier="student-v2",
        policyVersion="evidence-v2",
        basis="repository_synthetic",
        falsePositiveRate=0.0,
        benignWarningCount=0,
        criticalMissCount=0,
        independentTestGroups=1,
    )
    metadata = ModelMetadata(
        version="1.1.0",
        name="student-onnx-behavioral",
        architecture="1D-CNN + BiLSTM",
        sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        fileSizeBytes=107168,
        releasedAt=datetime.now(timezone.utc),
        minExtensionVersion="0.1.0",
        features=["x", "y", "dx", "dy", "v", "theta"],
        metrics=ModelMetrics(
            accuracy=0.982,
            f1Score=0.976,
            latencyMs=14.5,
            memoryBudgetMb=32.0,
        ),
        changelog=["Fine-tuned on synthetic Bézier hesitation curves"],
        downloadUrl="/v1/models/student-onnx-v1.1.0/download",
        inputContract=input_contract,
        validationSummary=validation_summary,
    )
    assert metadata.version == "1.1.0"
    assert metadata.metrics.accuracy == 0.982
    assert metadata.inputContract.inputs[2].name == "page_context"
    assert metadata.validationSummary.passedAllGates is False
    legacy_metadata = ModelMetadata(
        version="1.5.0",
        name="legacy-student",
        architecture="legacy",
        sha256="a" * 64,
        fileSizeBytes=10,
        releasedAt=datetime.now(timezone.utc),
        metrics=ModelMetrics(accuracy=0.0, f1Score=0.0, latencyMs=0.0, memoryBudgetMb=1.0),
        downloadUrl="/legacy",
        inputContract=None,
        validationSummary=None,
    )
    assert legacy_metadata.model_dump()["inputContract"] is None
    assert legacy_metadata.model_dump()["validationSummary"] is None
    with pytest.raises(ValidationError):
        ModelMetrics(accuracy=float("nan"), f1Score=0.0, latencyMs=0.0, memoryBudgetMb=1.0)
    with pytest.raises(ValidationError):
        ModelMetrics(accuracy=1.0, f1Score=float("inf"), latencyMs=0.0, memoryBudgetMb=1.0)
    with pytest.raises(ValidationError):
        ModelMetrics(accuracy=1.0, f1Score=1.0, latencyMs=float("nan"), memoryBudgetMb=1.0)
    with pytest.raises(ValidationError):
        ModelInputTensor(name="trajectory", dtype="float32", shape=[1, 0, 6])
    with pytest.raises(ValidationError):
        ModelInputTensor(name="trajectory", dtype="float32", shape=[1, 128, 6], secret="blocked")
    with pytest.raises(ValidationError):
        ModelValidationSummary(
            passedAllGates=False,
            modelSha256="not-a-hash",
            corpusDigest="1" * 64,
            reportSha256="2" * 64,
            inputContractIdentifier="student-v2",
            policyVersion="evidence-v2",
            basis="repository_synthetic",
            falsePositiveRate=0.0,
            benignWarningCount=0,
            criticalMissCount=0,
            independentTestGroups=1,
        )

    check = CheckUpdateRequest(
        currentVersion="1.5.0",
        extensionVersion="0.4.13",
        supportedInputContracts=["legacy-v1", "student-v2"],
    )
    assert check.supportedInputContracts == ["legacy-v1", "student-v2"]
    nullable_check = CheckUpdateRequest(
        currentVersion="1.5.0",
        currentSha256=None,
        extensionVersion=None,
        supportedInputContracts=None,
    )
    assert nullable_check.model_dump()["extensionVersion"] is None

    status = ModelSyncStatus(
        currentVersion="1.0.0",
        latestAvailableVersion="1.1.0",
        isLatest=False,
        lastSyncAttempt=datetime.now(timezone.utc),
        syncState=ModelSyncState.ONLINE_UPDATE_AVAILABLE,
        backendReachable=True,
        modelSource=ModelSource.LOCAL_BUNDLED,
        activeMetadata=metadata,
    )
    assert status.syncState == ModelSyncState.ONLINE_UPDATE_AVAILABLE
    assert status.isLatest is False


def test_extension_release_and_update_status():
    from phishguard_types import (
        ExtensionDistributionChannel,
        ExtensionReleaseMeta,
        ExtensionUpdateChannel,
        ExtensionUpdateCheckMethod,
        ExtensionUpdateStatus,
    )

    channel = ExtensionDistributionChannel(
        channel="chrome_web_store",
        label="Chrome Web Store (ZIP package)",
        url="/download/extension",
        format="zip",
    )
    assert channel.channel == "chrome_web_store"

    release_meta = ExtensionReleaseMeta(
        name="PhishGuard Browser Extension",
        version="0.2.0",
        extension_id="abcdefghijklmnopabcdefghijklmnop",
        filename="phishguard-extension.zip",
        versioned_filename="phishguard-extension-v0.2.0.zip",
        download_url="/download/extension",
        crx_filename="phishguard-extension.crx",
        crx_download_url="/download/crx",
        updates_url="/download/updates.xml",
        sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        size_bytes=1048576,
        size_formatted="1.00 MB",
        crx_sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        crx_size_bytes=1050000,
        crx_size_formatted="1.00 MB",
        webstore_filename="phishguard-extension-webstore.zip",
        webstore_download_url="/download/phishguard-extension-webstore.zip",
        built_at=datetime.now(timezone.utc).isoformat(),
        distribution_channels=[channel],
    )
    assert release_meta.version == "0.2.0"
    assert release_meta.distribution_channels[0].format == "zip"

    update_status = ExtensionUpdateStatus(
        currentVersion="0.1.0",
        latestVersion="0.2.0",
        updateAvailable=True,
        lastChecked=datetime.now(timezone.utc),
        checkMethod=ExtensionUpdateCheckMethod.API_POLL,
        backendReachable=True,
        releaseMeta=release_meta,
        statusMessage="New version v0.2.0 available",
        installPromptShown=False,
    )
    assert update_status.updateAvailable is True
    assert update_status.checkMethod == ExtensionUpdateCheckMethod.API_POLL
    assert update_status.updateChannel is None
    assert update_status.nativeUpdateReady is False
    assert release_meta.webstore_filename == "phishguard-extension-webstore.zip"

    native_status = ExtensionUpdateStatus(
        currentVersion="0.3.0",
        latestVersion="0.3.1",
        updateAvailable=True,
        lastChecked=datetime.now(timezone.utc),
        checkMethod=ExtensionUpdateCheckMethod.NATIVE_RUNTIME,
        backendReachable=True,
        updateChannel=ExtensionUpdateChannel.NATIVE,
        nativeUpdateReady=True,
    )
    assert native_status.updateChannel == ExtensionUpdateChannel.NATIVE
    assert native_status.nativeUpdateReady is True

    with pytest.raises(ValidationError):
        ExtensionUpdateStatus(
            currentVersion="0.3.0",
            latestVersion="0.3.1",
            updateAvailable=True,
            lastChecked=datetime.now(timezone.utc),
            checkMethod=ExtensionUpdateCheckMethod.NATIVE_RUNTIME,
            backendReachable=True,
            updateChannel="BOGUS",
        )


def test_multimodal_dataset_and_sota_benchmark_schema():
    from phishguard_types import (
        DatasetProvenance,
        TargetBrandClass,
        VisualElementType,
        LogoGroundingSpec,
        ImageDetectionAnnotation,
        MultimodalDatasetSample,
        DatasetSplitStats,
        DatasetManifest,
        SOTABenchmarkReport,
    )

    sample_id = uuid4()
    logo = LogoGroundingSpec(
        brandName=TargetBrandClass.MICROSOFT,
        brandId=0,
        boundingBox=ElementBoundingBox(x=0.05, y=0.05, width=0.15, height=0.08),
        confidence=0.98,
        domainMatchesBrand=False,
    )
    assert logo.domainMatchesBrand is False

    detection = ImageDetectionAnnotation(
        category=VisualElementType.INPUT_CREDENTIAL,
        boundingBox=ElementBoundingBox(x=0.2, y=0.4, width=0.6, height=0.06),
        confidence=0.95,
    )
    assert detection.category == VisualElementType.INPUT_CREDENTIAL

    sample = MultimodalDatasetSample(
        sampleId=sample_id,
        label=1.0,
        url="https://login-microsoft-secure.auth-verify.xyz/signin",
        domain="auth-verify.xyz",
        targetBrand=TargetBrandClass.MICROSOFT,
        logoDetections=[logo],
        imageDetections=[detection],
        createdAt=datetime.now(timezone.utc),
        provenance=DatasetProvenance(
            sourceType="repository_fixture",
            labelSource="manual_fixture",
            labelConfidence=1.0,
            labelReason="Curated schema contract fixture",
            modalities={"domEvents": "synthetic"},
        ),
    )
    assert sample.label == 1.0
    assert sample.targetBrand == TargetBrandClass.MICROSOFT
    assert sample.provenance is not None
    assert sample.provenance.sourceType == "repository_fixture"

    manifest = DatasetManifest(
        datasetName="phishguard-multimodal-sota",
        datasetVersion="1.0.0",
        createdAt=datetime.now(timezone.utc).isoformat(),
        totalSamples=1000,
        splits={
            "train": DatasetSplitStats(
                totalSamples=700,
                phishingSamples=350,
                benignSamples=350,
                samplesWithLogo=400,
                samplesWithScreenshot=700,
            ),
            "val": DatasetSplitStats(
                totalSamples=150,
                phishingSamples=75,
                benignSamples=75,
                samplesWithLogo=80,
                samplesWithScreenshot=150,
            ),
            "test": DatasetSplitStats(
                totalSamples=150,
                phishingSamples=75,
                benignSamples=75,
                samplesWithLogo=80,
                samplesWithScreenshot=150,
            ),
        },
        modalitiesSupported=["url", "hid_input", "logo", "screen", "image_detection"],
        sotaBenchmarkTargets={
            "min_accuracy": 0.985,
            "min_precision": 0.985,
            "min_recall": 0.980,
            "min_f1": 0.982,
            "max_fpr": 0.005,
            "min_roc_auc": 0.990,
            "max_brier": 0.05,
            "max_latency_ms": 30.0,
        },
        featureDimensions={
            "url": 32,
            "hid": 16,
            "logo": 16,
            "detection": 16,
            "viewport_h": 224,
            "viewport_w": 224,
        },
    )
    assert manifest.totalSamples == 1000
    assert len(manifest.modalitiesSupported) == 5

    report = SOTABenchmarkReport(
        modelName="phishguard-sota-unified-v1",
        evaluatedAt=datetime.now(timezone.utc).isoformat(),
        datasetVersion="1.0.0",
        passedSotaBenchmark=True,
        accuracy=0.992,
        precision=0.991,
        recall=0.993,
        f1Score=0.992,
        falsePositiveRate=0.003,
        rocAuc=0.998,
        brierScore=0.021,
        latencyMsAvg=12.4,
        benchmarkThresholds=manifest.sotaBenchmarkTargets,
        gateFailures=[],
    )
    assert report.passedSotaBenchmark is True
    assert report.falsePositiveRate <= 0.005


def test_dataset_provenance_feed_and_research_values():
    from phishguard_types import DatasetProvenance

    feed = DatasetProvenance(
        sourceType="public_feed",
        labelSource="verified_feed",
        labelConfidence=0.97,
        labelReason="OpenPhish community feed listing",
        modalities={"url": "observed"},
    )
    assert feed.sourceType == "public_feed"
    assert feed.labelSource == "verified_feed"

    research = DatasetProvenance(
        sourceType="research_agent",
        labelSource="llm_research",
        labelConfidence=0.6,
        labelReason="Deep Research (new_phishing_datasets): vendor IOC report",
        modalities={"url": "observed"},
    )
    assert research.sourceType == "research_agent"
    assert research.labelSource == "llm_research"

    with pytest.raises(ValidationError):
        DatasetProvenance(
            sourceType="bogus_source",
            labelSource="verified_feed",
            labelConfidence=0.5,
            labelReason="x",
        )
    with pytest.raises(ValidationError):
        DatasetProvenance(
            sourceType="public_feed",
            labelSource="bogus_label_source",
            labelConfidence=0.5,
            labelReason="x",
        )




def test_interaction_telemetry_has_credential_field():
    defaults = InteractionTelemetryPayload(
        telemetryId=uuid4(),
        url="https://example.com/login",
        domain="example.com",
        sessionDurationMs=0.0,
        clientTimestamp="2026-01-01T00:00:00Z",
    )
    assert defaults.pointerSeries == []
    assert defaults.keystrokes == []
    assert defaults.domEvents == []
    base = {
        "telemetryId": "11111111-1111-4111-8111-111111111111",
        "url": "https://example.com/login",
        "domain": "example.com",
        "sessionDurationMs": 100.0,
        "pointerSeries": [],
        "keystrokes": [],
        "domEvents": [],
        "clientTimestamp": "2026-01-01T00:00:00Z",
    }
    assert InteractionTelemetryPayload(**base).hasCredentialField is False
    assert InteractionTelemetryPayload(**base, hasCredentialField=True).hasCredentialField is True
    with pytest.raises(ValidationError):
        InteractionTelemetryPayload(**base, hasCredentialField="yes")
    with pytest.raises(ValidationError):
        InteractionTelemetryPayload(**{**base, "sessionDurationMs": float("inf")})
    with pytest.raises(ValidationError):
        InteractionTelemetryPayload(**base, unexpectedTelemetry="not allowed")


def test_escalation_screenshot_validation():
    base = {
        "telemetryId": uuid4(),
        "url": "https://example.com/login",
        "domain": "example.com",
        "clientRiskScore": 0.5,
        "clientTimestamp": datetime.now(timezone.utc),
    }
    assert EscalationPayload(**base).screenshotBase64 is None
    assert EscalationPayload(**base).hasCredentialField is False
    assert EscalationPayload(
        **base,
        hasCredentialField=True,
        clientModelVersion="1.5.0",
        clientModelSha256="a" * 64,
        clientInputContract="legacy-v1",
    ).clientInputContract == "legacy-v1"
    with pytest.raises(ValidationError):
        EscalationPayload(**base, clientModelSha256="invalid")
    assert EscalationPayload(**base, screenshotBase64=None).screenshotBase64 is None
    assert EscalationPayload(**base, screenshotBase64="data:image/webp;base64,UklGRiQAAABXRUJQ")
    assert EscalationPayload(**base, screenshotBase64="data:image/jpeg;base64,/9j/4AAQSkZJRg==")
    with pytest.raises(ValidationError):
        EscalationPayload(**base, screenshotBase64="data:image/png;base64,iVBORw0KGgo=")
    with pytest.raises(ValidationError):
        EscalationPayload(**base, screenshotBase64="data:image/webp;base64," + "A" * 2_100_000)
    assert EscalationPayload(**base, screenshotBase64="data:image/jpeg;base64," + "A" * (2_000_000 - 23))


def test_screen_analysis_and_verdict_extensions():
    from phishguard_types import ScreenAnalysis

    analysis = ScreenAnalysis(
        screenRiskScore=0.9, detectedBrand="PayPal", credentialFormVisible=True,
        urgencyCues=["Account suspended"], onScreenUrlMismatch=True, reasons=["Fake address bar"],
    )
    assert analysis.screenRiskScore == 0.9
    assert ScreenAnalysis(screenRiskScore=0.1, credentialFormVisible=False, onScreenUrlMismatch=False).urgencyCues == []
    base = dict(screenRiskScore=0.5, credentialFormVisible=False, onScreenUrlMismatch=False)
    for bad in (
        dict(extra="x"), dict(screenRiskScore=1.5), dict(screenRiskScore=float("nan")),
        dict(detectedBrand="b" * 65), dict(urgencyCues=["x"] * 7), dict(urgencyCues=["x" * 121]),
        dict(reasons=["x"] * 7), dict(reasons=["x" * 301]),
    ):
        with pytest.raises(ValidationError):
            ScreenAnalysis(**{**base, **bad})
    common = dict(
        analysisId=uuid4(), telemetryId=uuid4(), isPhishing=False, confidence=0.5,
        actionOverride=CloudActionOverride.WARN, teacherModelVersion="t", evaluatedAt=datetime.now(timezone.utc),
    )
    legacy = CloudInferenceVerdict(**common)
    assert legacy.riskScore is None and legacy.screenAnalysis is None
    full = CloudInferenceVerdict(**common, riskScore=0.5, screenAnalysis=analysis)
    assert full.screenAnalysis.detectedBrand == "PayPal"
    for bad_risk in (1.01, -0.1):
        with pytest.raises(ValidationError):
            CloudInferenceVerdict(**common, riskScore=bad_risk)


def test_warning_presentation_config():
    from phishguard_types import WarningPresentationType, ExtensionWarningConfig

    assert WarningPresentationType.SMART == "smart"
    assert WarningPresentationType.OVERLAY == "overlay"
    assert WarningPresentationType.BANNER == "banner"
    assert WarningPresentationType.NOTIFICATION == "notification"

    default_config = ExtensionWarningConfig()
    assert default_config.warningType == WarningPresentationType.SMART
    assert default_config.snoozeDurationMinutes == 15
    assert default_config.snoozedDomains == {}
    assert default_config.acknowledgedDomains == {}

    custom_config = ExtensionWarningConfig(
        warningType=WarningPresentationType.BANNER,
        snoozeDurationMinutes=60,
        snoozedDomains={"bank-phish.xyz": 1760000000000},
        acknowledgedDomains={"internal.corp": 1760000000000},
    )
    assert custom_config.warningType == WarningPresentationType.BANNER
    assert custom_config.snoozeDurationMinutes == 60
    assert custom_config.snoozedDomains["bank-phish.xyz"] == 1760000000000

    with pytest.raises(ValidationError):
        ExtensionWarningConfig(warningType="unsupported_type")


def _playground_payload():
    return EscalationPayload(
        telemetryId=uuid4(),
        url="https://login-verify-paypa1.xyz/signin",
        domain="login-verify-paypa1.xyz",
        clientRiskScore=0.0,
        clientTimestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def _playground_verdict(payload):
    return CloudInferenceVerdict(
        analysisId=uuid4(),
        telemetryId=payload.telemetryId,
        isPhishing=True,
        confidence=0.9,
        actionOverride=CloudActionOverride.BLOCK,
        explanationReasons=["trap"],
        teacherModelVersion="cloud-evidence-v2",
        evaluatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def test_playground_schemas_round_trip_and_forbid_extra():
    payload = _playground_payload()
    verdict = _playground_verdict(payload)
    scenario = PlaygroundScenario(id="brand-impersonation", title="t", tagline="g", payload=payload)
    listing = PlaygroundScenarioList(scenarios=[scenario], geminiConfigured=False, geminiModel=None)
    assert PlaygroundScenarioList.model_validate(listing.model_dump(mode="json")) == listing

    trace = TeacherTrace(
        status=TeacherTraceStatus.OK,
        model="m",
        toolCalls=[TeacherToolCall(name="x", args={"a": 1}, result={"b": [2]})],
        latencyMs=12.5,
        cached=False,
    )
    response = PlaygroundRunResponse.model_validate({
        "payload": payload.model_dump(mode="json"),
        "evidence": {"verdict": verdict.model_dump(mode="json"), "latencyMs": 1.0, "cached": False},
        "gemini": {
            "verdict": verdict.model_dump(mode="json"),
            "latencyMs": 2.0,
            "cached": True,
            "trace": trace.model_dump(mode="json"),
        },
    })
    assert response.gemini.trace.status == TeacherTraceStatus.OK
    assert response.gemini.trace.fallbackReason is None

    with pytest.raises(ValidationError):
        PlaygroundScenario(id="Bad ID", title="t", tagline="g", payload=payload)
    with pytest.raises(ValidationError):
        PlaygroundScenarioList(scenarios=[], geminiConfigured=True, geminiModel=None, extra=1)
    with pytest.raises(ValidationError):
        TeacherTrace(status="weird", latencyMs=1.0, cached=False)
    with pytest.raises(ValidationError):
        TeacherTrace(status="ok", latencyMs=-1.0, cached=False, surprise=True)


def test_playground_run_request_validation():
    req = PlaygroundRunRequest(clientRiskScore=0.5, clientModelSha256="a" * 64)
    assert req.clientModelVersion is None
    for bad in (1.5, -0.1, float("nan"), float("inf")):
        with pytest.raises(ValidationError):
            PlaygroundRunRequest(clientRiskScore=bad)
    with pytest.raises(ValidationError):
        PlaygroundRunRequest(clientRiskScore=0.5, clientModelSha256="xyz")
    with pytest.raises(ValidationError):
        PlaygroundRunRequest(clientRiskScore=0.5, extra="no")


def _interaction_point(i=0):
    return {
        "x": 0.5, "y": 0.5, "dx": 0.0, "dy": 0.0, "velocity": 0.0, "acceleration": 0.0,
        "angle": 0.0, "timestamp": float(i), "eventType": "move",
    }


def _observed_event(**overrides):
    event = {
        "eventType": "focus",
        "targetBoundingBox": {"x": 1, "y": 2, "width": 3, "height": 4},
        "isZeroOpacity": False,
        "isCrossOriginIframe": False,
        "isPasswordInput": True,
        "isPasteIntoPassword": False,
        "elementSelector": "input#password",
        "timestamp": 10.0,
        "evidenceSource": "observed_interaction",
    }
    event.update(overrides)
    return event


def test_playground_interaction_valid_and_in_run_request():
    interaction = PlaygroundInteraction.model_validate({
        "mouseTrajectorySeries": [_interaction_point()],
        "keystrokesSummary": [{"category": "ALPHANUMERIC", "dwellTimeMs": 80, "flightTimeMs": 100, "timestamp": 5}],
        "observedDomEvents": [_observed_event()],
    })
    request = PlaygroundRunRequest(clientRiskScore=0.5, interaction=interaction)
    assert request.interaction is not None and len(request.interaction.observedDomEvents) == 1
    assert PlaygroundRunRequest(clientRiskScore=0.5).interaction is None
    defaults = PlaygroundInteraction.model_validate({"mouseTrajectorySeries": [_interaction_point()]})
    assert defaults.keystrokesSummary == [] and defaults.observedDomEvents == []


@pytest.mark.parametrize("mutation", [
    lambda d: d.update(url="https://evil.test/"),
    lambda d: d.update(screenshotBase64="data:image/jpeg;base64,AA=="),
    lambda d: d.update(keystrokesSummary=[{"category": "ALPHANUMERIC", "dwellTimeMs": 1, "flightTimeMs": 1, "timestamp": 1, "key": "a"}]),
    lambda d: d.update(keystrokesSummary=[{"category": "ALPHANUMERIC", "dwellTimeMs": 1, "flightTimeMs": 1, "timestamp": 1, "char": "a"}]),
    lambda d: d.update(observedDomEvents=[_observed_event(evidenceSource="topology_scan")]),
    lambda d: d.update(observedDomEvents=[_observed_event(evidenceSource="legacy")]),
    lambda d: d.update(observedDomEvents=[{k: v for k, v in _observed_event().items() if k != "evidenceSource"}]),
    lambda d: d.update(mouseTrajectorySeries=[_interaction_point(i) for i in range(129)]),
    lambda d: d.update(mouseTrajectorySeries=[]),
    lambda d: d.update(observedDomEvents=[_observed_event() for _ in range(33)]),
])
def test_playground_interaction_rejects_bad_input(mutation):
    data = {"mouseTrajectorySeries": [_interaction_point()]}
    mutation(data)
    with pytest.raises(ValidationError):
        PlaygroundInteraction.model_validate(data)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PointerEventPointSchema,
  KeystrokeDynamicsSchema,
  DOMInteractionEventSchema,
  ViewportCaptureSpecSchema,
  EscalationPayloadSchema,
  CloudInferenceVerdictSchema,
  ClientInferenceResultSchema,
  ScreenAnalysisSchema,
  InteractionTelemetryPayloadSchema,
  WarningPresentationTypeSchema,
  ExtensionWarningConfigSchema,
  PlaygroundScenarioSchema,
  PlaygroundScenarioListSchema,
  PlaygroundRunRequestSchema,
  PlaygroundInteractionSchema,
  PlaygroundRunResponseSchema,
  TeacherTraceSchema,
} from '../dist/index.js';

test('PointerEventPointSchema validates correct normalized coordinates', () => {
  const validPoint = {
    x: 0.35,
    y: 0.65,
    dx: 2.1,
    dy: -0.8,
    velocity: 0.22,
    acceleration: 0.01,
    angle: -0.36,
    timestamp: 150,
    eventType: 'move',
  };
  const parsed = PointerEventPointSchema.parse(validPoint);
  assert.equal(parsed.x, 0.35);
  assert.equal(parsed.eventType, 'move');
});

test('PointerEventPointSchema throws on out-of-bound coordinates', () => {
  const invalidPoint = {
    x: 1.5,
    y: 0.5,
    dx: 0,
    dy: 0,
    velocity: 0,
    acceleration: 0,
    angle: 0,
    timestamp: 0,
    eventType: 'move',
  };
  assert.throws(() => PointerEventPointSchema.parse(invalidPoint));
});

test('KeystrokeDynamicsSchema enforces privacy without raw key chars', () => {
  const ks = {
    category: 'ALPHANUMERIC',
    dwellTimeMs: 80,
    flightTimeMs: 110,
    timestamp: 300,
  };
  const parsed = KeystrokeDynamicsSchema.parse(ks);
  assert.equal(parsed.category, 'ALPHANUMERIC');
});

test('DOMInteractionEventSchema defaults legacy evidence and validates provenance fields', () => {
  const legacy = DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: 1, y: 2, width: 30, height: 20 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'form > input',
    timestamp: 10,
  });
  assert.equal(legacy.evidenceSource, 'legacy');
  assert.equal(DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: 1, y: 2, width: 30, height: 20 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'form > input',
    timestamp: 10,
    evidenceId: null,
  }).evidenceId, null);
  assert.equal(legacy.isHitTestIntercepting, false);
  assert.equal(legacy.coveredControlType, 'none');
  assert.equal(legacy.credentialFrameEvidence, 'none');

  const observed = DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: 1, y: 2, width: 30, height: 20 },
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'form > button',
    timestamp: 10,
    evidenceSource: 'topology_scan',
    evidenceId: 'doc1-element2',
    isHitTestIntercepting: true,
    coveredControlType: 'submit',
    credentialFrameEvidence: 'unverified',
  });
  assert.equal(observed.evidenceSource, 'topology_scan');
  assert.equal(observed.coveredControlType, 'submit');
  assert.throws(() => DOMInteractionEventSchema.parse({
    ...observed,
    evidenceId: 'page text',
  }));
  assert.throws(() => DOMInteractionEventSchema.parse({ ...observed, unrecognized: true }));
});

test('telemetry schemas reject non-finite values and nested extra fields', () => {
  const point = {
    x: 0.1,
    y: 0.2,
    dx: 0,
    dy: 0,
    velocity: 0,
    acceleration: 0,
    angle: 0,
    timestamp: 0,
    eventType: 'move',
  };
  assert.throws(() => PointerEventPointSchema.parse({ ...point, dx: Infinity }));
  assert.throws(() => PointerEventPointSchema.parse({ ...point, acceleration: NaN }));
  assert.throws(() => DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: NaN, y: 2, width: 30, height: 20 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'button',
    timestamp: 10,
  }));
  assert.throws(() => DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: 1, y: 2, width: 30, height: 20 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'button',
    timestamp: Infinity,
  }));
  assert.throws(() => ViewportCaptureSpecSchema.parse({
    width: 64,
    height: 64,
    mimeType: 'image/webp',
    base64Data: 'AA==',
    scrollOffset: { x: 0, y: 1, extra: 2 },
    capturedAt: 10,
  }));
  const captureDefaults = ViewportCaptureSpecSchema.parse({
    width: 64,
    height: 64,
    mimeType: 'image/webp',
    base64Data: 'AA==',
    capturedAt: 10,
  });
  assert.deepEqual(captureDefaults.scrollOffset, { x: 0, y: 0 });
  assert.equal(captureDefaults.devicePixelRatio, 1);
  assert.throws(() => ViewportCaptureSpecSchema.parse({
    width: 64,
    height: 64,
    mimeType: 'image/webp',
    base64Data: 'AA==',
    scrollOffset: { x: 0, y: Infinity },
    capturedAt: 10,
  }));
  assert.throws(() => DOMInteractionEventSchema.parse({
    eventType: 'click',
    targetBoundingBox: { x: 1, y: 2, width: 30, height: 20, text: 'private' },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'button',
    timestamp: 10,
  }));
});

test('EscalationPayload and CloudInferenceVerdict schema validation', () => {
  const payload = {
    telemetryId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    url: 'https://security-notice-update.com/login',
    domain: 'security-notice-update.com',
    clientRiskScore: 0.74,
    mouseTrajectorySeries: [
      {
        x: 0.1,
        y: 0.2,
        dx: 0.5,
        dy: 0.5,
        velocity: 0.1,
        acceleration: 0.0,
        angle: 0.78,
        timestamp: 10,
        eventType: 'move',
      },
    ],
    domElementsSummary: [
      {
        eventType: 'click',
        targetBoundingBox: { x: 100, y: 100, width: 200, height: 40 },
        isZeroOpacity: false,
        isCrossOriginIframe: true,
        isPasswordInput: true,
        isPasteIntoPassword: true,
        elementSelector: 'iframe > form > input#password',
        timestamp: 400,
      },
    ],
    keystrokesSummary: [],
    clientTimestamp: new Date().toISOString(),
  };

  const parsedPayload = EscalationPayloadSchema.parse(payload);
  assert.equal(parsedPayload.clientRiskScore, 0.74);
  assert.equal(parsedPayload.hasCredentialField, false);

  const verdict = {
    analysisId: '8ba40120-7b3b-419b-a010-85f2ad76a100',
    telemetryId: parsedPayload.telemetryId,
    isPhishing: true,
    targetBrand: 'Google',
    confidence: 0.98,
    actionOverride: 'BLOCK',
    explanationReasons: ['Cross-origin iframe credential solicitation'],
    teacherModelVersion: 'teacher-v1.0',
    evaluatedAt: new Date().toISOString(),
  };

  const parsedVerdict = CloudInferenceVerdictSchema.parse(verdict);
  assert.equal(parsedVerdict.isPhishing, true);
  assert.equal(parsedVerdict.actionOverride, 'BLOCK');
});

test('ScreenAnalysisSchema and verdict screen fields validate correctly', () => {
  const analysis = {
    screenRiskScore: 0.9,
    detectedBrand: 'PayPal',
    credentialFormVisible: true,
    urgencyCues: ['Account suspended'],
    onScreenUrlMismatch: true,
    reasons: ['Fake address bar'],
  };
  assert.equal(ScreenAnalysisSchema.parse(analysis).detectedBrand, 'PayPal');
  assert.deepEqual(
    ScreenAnalysisSchema.parse({ screenRiskScore: 0.1, credentialFormVisible: false, onScreenUrlMismatch: false }).urgencyCues,
    [],
  );
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, extra: 'x' }));
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, screenRiskScore: 1.5 }));
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, detectedBrand: 'b'.repeat(65) }));
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, urgencyCues: Array(7).fill('x') }));
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, urgencyCues: ['x'.repeat(121)] }));
  assert.throws(() => ScreenAnalysisSchema.parse({ ...analysis, reasons: ['x'.repeat(301)] }));
  const verdict = {
    analysisId: '123e4567-e89b-42d3-a456-426614174000',
    telemetryId: '123e4567-e89b-42d3-a456-426614174001',
    isPhishing: false,
    confidence: 0.5,
    actionOverride: 'WARN',
    explanationReasons: [],
    teacherModelVersion: 't',
    evaluatedAt: new Date().toISOString(),
  };
  assert.equal(CloudInferenceVerdictSchema.parse(verdict).riskScore, undefined);
  assert.equal(CloudInferenceVerdictSchema.parse({ ...verdict, riskScore: 0.5, screenAnalysis: analysis }).riskScore, 0.5);
  assert.equal(CloudInferenceVerdictSchema.parse({ ...verdict, riskScore: null, screenAnalysis: null }).screenAnalysis, null);
  assert.throws(() => CloudInferenceVerdictSchema.parse({ ...verdict, riskScore: 1.01 }));
});

test('ModelMetadataSchema and ModelSyncStatusSchema validate correctly', async () => {
  const {
    ModelMetadataSchema,
    ModelMetricsSchema,
    ModelSyncStatusSchema,
    CheckUpdateRequestSchema,
  } = await import('../dist/index.js');

  const metadata = {
    version: '1.1.0',
    name: 'student-onnx-behavioral',
    architecture: '1D-CNN + BiLSTM',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    fileSizeBytes: 107168,
    releasedAt: new Date().toISOString(),
    minExtensionVersion: '0.1.0',
    features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
    metrics: {
      accuracy: 0.985,
      f1Score: 0.978,
      latencyMs: 12.4,
      memoryBudgetMb: 35.0,
    },
    changelog: ['Upgraded angular jitter detection'],
    downloadUrl: '/v1/models/student-onnx-v1.1.0/download',
    inputContract: {
      identifier: 'student-v2',
      trajectoryPreprocessing: 'trajectory-v2',
      inputs: [
        { name: 'trajectory', dtype: 'float32', shape: [1, 128, 6] },
        { name: 'visual', dtype: 'float32', shape: [1, 3, 64, 64] },
        { name: 'page_context', dtype: 'float32', shape: [1, 16] },
      ],
      contextFeatures: ['url_userinfo', 'https'],
    },
    validationSummary: {
      passedAllGates: false,
      modelSha256: '0'.repeat(64),
      corpusDigest: '1'.repeat(64),
      reportSha256: '2'.repeat(64),
      inputContractIdentifier: 'student-v2',
      policyVersion: 'evidence-v2',
      basis: 'repository_synthetic',
      falsePositiveRate: 0,
      benignWarningCount: 0,
      criticalMissCount: 0,
      independentTestGroups: 1,
    },
  };

  const parsedMeta = ModelMetadataSchema.parse(metadata);
  assert.throws(() => ModelMetricsSchema.parse({
    accuracy: NaN,
    f1Score: 1,
    latencyMs: 0,
    memoryBudgetMb: 1,
  }));
  assert.throws(() => ModelMetricsSchema.parse({
    accuracy: 1,
    f1Score: Infinity,
    latencyMs: 0,
    memoryBudgetMb: 1,
  }));
  assert.equal(parsedMeta.version, '1.1.0');
  assert.equal(parsedMeta.inputContract?.inputs[2].name, 'page_context');
  assert.equal(parsedMeta.validationSummary?.passedAllGates, false);
  assert.throws(() => ModelMetadataSchema.parse({
    ...metadata,
    inputContract: { ...metadata.inputContract, extra: true },
  }));
  assert.throws(() => ModelMetadataSchema.parse({
    ...metadata,
    inputContract: {
      ...metadata.inputContract,
      inputs: [{ name: 'trajectory', dtype: 'float32', shape: [1, 0, 6] }],
    },
  }));
  assert.throws(() => ModelMetadataSchema.parse({
    ...metadata,
    validationSummary: { ...metadata.validationSummary, falsePositiveRate: Infinity },
  }));
  const nullableMetadata = ModelMetadataSchema.parse({
    ...metadata,
    inputContract: null,
    validationSummary: null,
  });
  assert.equal(nullableMetadata.inputContract, null);
  assert.equal(nullableMetadata.validationSummary, null);
  assert.deepEqual(
    CheckUpdateRequestSchema.parse({
      currentVersion: '1.5.0',
      currentSha256: null,
      extensionVersion: '0.4.13',
      supportedInputContracts: ['legacy-v1', 'student-v2'],
    }).supportedInputContracts,
    ['legacy-v1', 'student-v2'],
  );
  assert.equal(CheckUpdateRequestSchema.parse({
    currentVersion: '1.5.0',
    extensionVersion: null,
    supportedInputContracts: null,
  }).supportedInputContracts, null);

  const syncStatus = {
    currentVersion: '1.0.0',
    latestAvailableVersion: '1.1.0',
    isLatest: false,
    lastSyncAttempt: new Date().toISOString(),
    syncState: 'ONLINE_UPDATE_AVAILABLE',
    backendReachable: true,
    modelSource: 'LOCAL_BUNDLED',
    activeMetadata: parsedMeta,
  };

  const parsedSync = ModelSyncStatusSchema.parse(syncStatus);
  assert.equal(parsedSync.syncState, 'ONLINE_UPDATE_AVAILABLE');
});

test('ExtensionReleaseMetaSchema and ExtensionUpdateStatusSchema validate correctly', async () => {
  const { ExtensionReleaseMetaSchema, ExtensionUpdateStatusSchema } = await import('../dist/index.js');

  const release = {
    name: 'PhishGuard Browser Extension',
    version: '0.2.0',
    extension_id: 'abcdefghijklmnopabcdefghijklmnop',
    filename: 'phishguard-extension.zip',
    versioned_filename: 'phishguard-extension-v0.2.0.zip',
    download_url: '/download/extension',
    crx_filename: 'phishguard-extension.crx',
    crx_download_url: '/download/crx',
    updates_url: '/download/updates.xml',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    size_bytes: 1048576,
    size_formatted: '1.00 MB',
    crx_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    crx_size_bytes: 1050000,
    crx_size_formatted: '1.00 MB',
    built_at: new Date().toISOString(),
    distribution_channels: [
      {
        channel: 'chrome_web_store',
        label: 'Chrome Web Store (ZIP package)',
        url: '/download/extension',
        format: 'zip',
      },
    ],
  };

  const parsedRelease = ExtensionReleaseMetaSchema.parse(release);
  assert.equal(parsedRelease.version, '0.2.0');

  const updateStatus = {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    lastChecked: new Date().toISOString(),
    checkMethod: 'API_POLL',
    backendReachable: true,
    releaseMeta: parsedRelease,
    statusMessage: 'Update v0.2.0 available',
    installPromptShown: false,
  };

  const parsedStatus = ExtensionUpdateStatusSchema.parse(updateStatus);
  assert.equal(parsedStatus.updateAvailable, true);
  assert.equal(parsedStatus.checkMethod, 'API_POLL');
});

test('MultimodalDatasetSampleSchema and SOTABenchmarkReportSchema validate correctly', async () => {
  const { MultimodalDatasetSampleSchema, SOTABenchmarkReportSchema } = await import('../dist/index.js');

  const sample = {
    sampleId: '11111111-2222-3333-4444-555555555555',
    label: 1.0,
    url: 'https://login.microsoft.security-verify.xyz/auth',
    domain: 'security-verify.xyz',
    targetBrand: 'Microsoft',
    pointerSeries: [],
    keystrokes: [],
    domEvents: [],
    logoDetections: [
      {
        brandName: 'Microsoft',
        brandId: 0,
        boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        confidence: 0.99,
        domainMatchesBrand: false,
      },
    ],
    imageDetections: [
      {
        category: 'input_credential',
        boundingBox: { x: 0.2, y: 0.3, width: 0.6, height: 0.08 },
        confidence: 0.96,
      },
    ],
    createdAt: new Date().toISOString(),
  };

  const parsed = MultimodalDatasetSampleSchema.parse(sample);
  assert.equal(parsed.label, 1.0);
  assert.equal(parsed.targetBrand, 'Microsoft');
  assert.equal(parsed.logoDetections[0].domainMatchesBrand, false);

  const report = {
    modelName: 'phishguard-sota-unified-v1',
    evaluatedAt: new Date().toISOString(),
    datasetVersion: '1.0.0',
    passedSotaBenchmark: true,
    accuracy: 0.991,
    precision: 0.989,
    recall: 0.992,
    f1Score: 0.990,
    falsePositiveRate: 0.004,
    rocAuc: 0.997,
    brierScore: 0.025,
    latencyMsAvg: 14.2,
    benchmarkThresholds: { min_accuracy: 0.985 },
    gateFailures: [],
  };

  const parsedReport = SOTABenchmarkReportSchema.parse(report);
  assert.equal(parsedReport.passedSotaBenchmark, true);
  assert.equal(parsedReport.accuracy, 0.991);
});

test('DatasetProvenanceSchema accepts feed and research values and rejects unknown ones', async () => {
  const { DatasetProvenanceSchema } = await import('../dist/index.js');

  const feed = DatasetProvenanceSchema.parse({
    sourceType: 'public_feed',
    labelSource: 'verified_feed',
    labelConfidence: 0.97,
    labelReason: 'OpenPhish community feed listing',
    modalities: { url: 'observed' },
  });
  assert.equal(feed.sourceType, 'public_feed');

  const research = DatasetProvenanceSchema.parse({
    sourceType: 'research_agent',
    labelSource: 'llm_research',
    labelConfidence: 0.6,
    labelReason: 'Deep Research (new_phishing_datasets): vendor IOC report',
    modalities: { url: 'observed' },
  });
  assert.equal(research.labelSource, 'llm_research');

  assert.throws(() => DatasetProvenanceSchema.parse({
    sourceType: 'bogus_source',
    labelSource: 'verified_feed',
    labelConfidence: 0.5,
    labelReason: 'x',
  }));
  assert.throws(() => DatasetProvenanceSchema.parse({
    sourceType: 'public_feed',
    labelSource: 'bogus_label_source',
    labelConfidence: 0.5,
    labelReason: 'x',
  }));
});


test('Extension update channel, native readiness and webstore fields validate correctly', async () => {
  const { ExtensionUpdateChannelSchema, ExtensionReleaseMetaSchema, ExtensionUpdateStatusSchema } = await import('../dist/index.js');

  assert.equal(ExtensionUpdateChannelSchema.parse('NATIVE'), 'NATIVE');
  assert.equal(ExtensionUpdateChannelSchema.parse('MANUAL_CRX'), 'MANUAL_CRX');
  assert.equal(ExtensionUpdateChannelSchema.parse('MANUAL_UNPACKED'), 'MANUAL_UNPACKED');
  assert.throws(() => ExtensionUpdateChannelSchema.parse('BOGUS'));

  const base = {
    currentVersion: '0.3.0',
    latestVersion: '0.3.1',
    updateAvailable: true,
    lastChecked: new Date().toISOString(),
    checkMethod: 'NATIVE_RUNTIME',
    backendReachable: true,
  };
  const defaults = ExtensionUpdateStatusSchema.parse(base);
  assert.equal(defaults.nativeUpdateReady, false);
  assert.equal(defaults.updateChannel, undefined);

  const ready = ExtensionUpdateStatusSchema.parse({ ...base, updateChannel: 'NATIVE', nativeUpdateReady: true });
  assert.equal(ready.updateChannel, 'NATIVE');
  assert.equal(ready.nativeUpdateReady, true);
  assert.throws(() => ExtensionUpdateStatusSchema.parse({ ...base, updateChannel: 'BOGUS' }));

  const meta = ExtensionReleaseMetaSchema.parse({
    name: 'PhishGuard Browser Extension',
    version: '0.3.0',
    filename: 'phishguard-extension.zip',
    download_url: '/download/extension',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    size_bytes: 1024,
    webstore_filename: 'phishguard-extension-webstore.zip',
    webstore_download_url: '/download/phishguard-extension-webstore.zip',
  });
  assert.equal(meta.webstore_filename, 'phishguard-extension-webstore.zip');
});

test('InteractionTelemetryPayloadSchema hasCredentialField defaults to false, accepts true and rejects non-boolean', async () => {
  const base = {
    telemetryId: '11111111-1111-4111-8111-111111111111',
    url: 'https://example.com/login',
    domain: 'example.com',
    sessionDurationMs: 100,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [],
    clientTimestamp: new Date().toISOString(),
  };
  assert.equal(InteractionTelemetryPayloadSchema.parse(base).hasCredentialField, false);
  const telemetryDefaults = InteractionTelemetryPayloadSchema.parse({
    ...base,
    pointerSeries: undefined,
    keystrokes: undefined,
    domEvents: undefined,
  });
  assert.deepEqual(telemetryDefaults.pointerSeries, []);
  assert.deepEqual(telemetryDefaults.keystrokes, []);
  assert.deepEqual(telemetryDefaults.domEvents, []);
  assert.equal(InteractionTelemetryPayloadSchema.parse({ ...base, hasCredentialField: true }).hasCredentialField, true);
  assert.throws(() => InteractionTelemetryPayloadSchema.parse({ ...base, hasCredentialField: 'yes' }));
  assert.throws(() => InteractionTelemetryPayloadSchema.parse({ ...base, sessionDurationMs: Infinity }));
  assert.throws(() => InteractionTelemetryPayloadSchema.parse({ ...base, unknownTelemetryField: true }));
});

test('EscalationPayloadSchema screenshotBase64 accepts webp/jpeg, null and absent; rejects oversized and wrong mime', () => {
  const base = {
    telemetryId: 'a1b2c3d4-e5f6-4a1b-9c2d-123456789abc',
    url: 'https://example.com/login',
    domain: 'example.com',
    clientRiskScore: 0.5,
    mouseTrajectorySeries: [],
    domElementsSummary: [],
    keystrokesSummary: [],
    clientTimestamp: new Date().toISOString(),
  };
  const ok = (screenshotBase64) => EscalationPayloadSchema.parse({ ...base, screenshotBase64 });
  assert.equal(EscalationPayloadSchema.parse(base).hasCredentialField, false);
  assert.equal(EscalationPayloadSchema.parse({
    ...base,
    clientModelVersion: null,
    clientModelSha256: null,
    clientInputContract: null,
  }).clientModelVersion, null);
  assert.equal(
    EscalationPayloadSchema.parse({
      ...base,
      clientModelVersion: '1.5.0',
      clientModelSha256: 'a'.repeat(64),
      clientInputContract: 'legacy-v1',
      hasCredentialField: true,
    }).clientModelSha256,
    'a'.repeat(64),
  );
  assert.throws(() => EscalationPayloadSchema.parse({ ...base, clientModelSha256: 'not-a-hash' }));
  assert.throws(() => EscalationPayloadSchema.parse({ ...base, private_value: 'unexpected' }));
  assert.ok(ok('data:image/webp;base64,UklGRiQAAABXRUJQ'));
  assert.ok(ok('data:image/jpeg;base64,/9j/4AAQSkZJRg=='));
  assert.equal(ok(null).screenshotBase64, null);
  assert.equal(EscalationPayloadSchema.parse(base).screenshotBase64, undefined);
  assert.throws(() => ok('data:image/png;base64,iVBORw0KGgo='));
  assert.throws(() => ok('not-a-data-url'));
  assert.throws(() => ok(`data:image/webp;base64,${'A'.repeat(2_100_000)}`));
  assert.ok(ok(`data:image/jpeg;base64,${'A'.repeat(2_000_000 - 23)}`));
});

test('WarningPresentationTypeSchema and ExtensionWarningConfigSchema validate correctly', () => {
  assert.equal(WarningPresentationTypeSchema.parse('smart'), 'smart');
  assert.equal(WarningPresentationTypeSchema.parse('overlay'), 'overlay');
  assert.equal(WarningPresentationTypeSchema.parse('banner'), 'banner');
  assert.equal(WarningPresentationTypeSchema.parse('notification'), 'notification');
  assert.throws(() => WarningPresentationTypeSchema.parse('invalid'));

  const cfg = ExtensionWarningConfigSchema.parse({});
  assert.equal(cfg.warningType, 'smart');
  assert.equal(cfg.snoozeDurationMinutes, 15);
  assert.deepEqual(cfg.snoozedDomains, {});
  assert.deepEqual(cfg.acknowledgedDomains, {});

  const custom = ExtensionWarningConfigSchema.parse({
    warningType: 'notification',
    snoozeDurationMinutes: 30,
    snoozedDomains: { 'example.com': 123456789 },
    acknowledgedDomains: { 'foo.com': 987654321 },
  });
  assert.equal(custom.warningType, 'notification');
  assert.equal(custom.snoozeDurationMinutes, 30);
  assert.equal(custom.snoozedDomains['example.com'], 123456789);
});

const playgroundPayload = {
  telemetryId: '6f1b0a6e-5f0e-4a39-9c0c-0d0a5c1a7a11',
  url: 'https://login-verify-paypa1.xyz/signin',
  domain: 'login-verify-paypa1.xyz',
  clientRiskScore: 0,
  clientTimestamp: '2026-01-01T00:00:00.000Z',
};
const playgroundVerdict = {
  analysisId: '6f1b0a6e-5f0e-4a39-9c0c-0d0a5c1a7a12',
  telemetryId: playgroundPayload.telemetryId,
  isPhishing: true,
  confidence: 0.9,
  actionOverride: 'BLOCK',
  explanationReasons: ['trap'],
  teacherModelVersion: 'cloud-evidence-v2',
  evaluatedAt: '2026-01-01T00:00:00.000Z',
};

test('Playground schemas round-trip and reject extra fields', () => {
  const scenario = { id: 'brand-impersonation', title: 't', tagline: 'g', payload: playgroundPayload };
  assert.equal(PlaygroundScenarioSchema.parse(scenario).id, 'brand-impersonation');
  assert.throws(() => PlaygroundScenarioSchema.parse({ ...scenario, id: 'Bad ID' }));
  const list = { scenarios: [scenario], geminiConfigured: false, geminiModel: null };
  assert.equal(PlaygroundScenarioListSchema.parse(list).geminiModel, null);
  assert.throws(() => PlaygroundScenarioListSchema.parse({ ...list, extra: 1 }));

  const trace = {
    status: 'ok',
    model: 'm',
    toolCalls: [{ name: 'x', args: { a: 1 }, result: { b: [2] } }],
    latencyMs: 1,
    cached: false,
    fallbackReason: null,
  };
  assert.equal(TeacherTraceSchema.parse(trace).toolCalls.length, 1);
  assert.throws(() => TeacherTraceSchema.parse({ ...trace, status: 'weird' }));
  assert.throws(() => TeacherTraceSchema.parse({ ...trace, latencyMs: -1 }));

  const response = {
    payload: playgroundPayload,
    evidence: { verdict: playgroundVerdict, latencyMs: 1, cached: false },
    gemini: { verdict: playgroundVerdict, latencyMs: 2, cached: true, trace },
  };
  assert.equal(PlaygroundRunResponseSchema.parse(response).gemini.trace.status, 'ok');
  assert.throws(() => PlaygroundRunResponseSchema.parse({ ...response, extra: true }));
});

test('PlaygroundRunRequestSchema rejects bad scores and hashes', () => {
  assert.equal(PlaygroundRunRequestSchema.parse({ clientRiskScore: 0.5, clientModelSha256: 'a'.repeat(64) }).clientRiskScore, 0.5);
  for (const bad of [1.5, -0.1, NaN, Infinity]) {
    assert.throws(() => PlaygroundRunRequestSchema.parse({ clientRiskScore: bad }));
  }
  assert.throws(() => PlaygroundRunRequestSchema.parse({ clientRiskScore: 0.5, clientModelSha256: 'xyz' }));
  assert.throws(() => PlaygroundRunRequestSchema.parse({ clientRiskScore: 0.5, extra: 1 }));
});

const interactionPoint = (i = 0) => ({
  x: 0.5, y: 0.5, dx: 0, dy: 0, velocity: 0, acceleration: 0, angle: 0, timestamp: i, eventType: 'move',
});
const observedEvent = (overrides = {}) => ({
  eventType: 'focus',
  targetBoundingBox: { x: 1, y: 2, width: 3, height: 4 },
  isZeroOpacity: false,
  isCrossOriginIframe: false,
  isPasswordInput: true,
  isPasteIntoPassword: false,
  elementSelector: 'input#password',
  timestamp: 10,
  evidenceSource: 'observed_interaction',
  ...overrides,
});

test('PlaygroundInteractionSchema accepts valid interaction and rejects bad input', () => {
  const valid = {
    mouseTrajectorySeries: [interactionPoint()],
    keystrokesSummary: [{ category: 'ALPHANUMERIC', dwellTimeMs: 80, flightTimeMs: 100, timestamp: 5 }],
    observedDomEvents: [observedEvent()],
  };
  assert.equal(PlaygroundInteractionSchema.parse(valid).observedDomEvents.length, 1);
  assert.equal(PlaygroundRunRequestSchema.parse({ clientRiskScore: 0.5, interaction: valid }).interaction.mouseTrajectorySeries.length, 1);
  assert.equal(PlaygroundRunRequestSchema.parse({ clientRiskScore: 0.5 }).interaction, undefined);
  const defaults = PlaygroundInteractionSchema.parse({ mouseTrajectorySeries: [interactionPoint()] });
  assert.deepEqual(defaults.keystrokesSummary, []);
  const { evidenceSource, ...noSource } = observedEvent();
  const bad = [
    { url: 'https://evil.test/' },
    { screenshotBase64: 'data:image/jpeg;base64,AA==' },
    { keystrokesSummary: [{ category: 'ALPHANUMERIC', dwellTimeMs: 1, flightTimeMs: 1, timestamp: 1, key: 'a' }] },
    { keystrokesSummary: [{ category: 'ALPHANUMERIC', dwellTimeMs: 1, flightTimeMs: 1, timestamp: 1, char: 'a' }] },
    { observedDomEvents: [observedEvent({ evidenceSource: 'topology_scan' })] },
    { observedDomEvents: [observedEvent({ evidenceSource: 'legacy' })] },
    { observedDomEvents: [noSource] },
    { mouseTrajectorySeries: Array.from({ length: 129 }, (_, i) => interactionPoint(i)) },
    { mouseTrajectorySeries: [] },
    { observedDomEvents: Array.from({ length: 33 }, () => observedEvent()) },
  ];
  for (const override of bad) {
    assert.throws(() => PlaygroundInteractionSchema.parse({ mouseTrajectorySeries: [interactionPoint()], ...override }));
  }
});

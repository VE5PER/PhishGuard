import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PointerEventPointSchema,
  KeystrokeDynamicsSchema,
  InteractionTelemetryPayloadSchema,
  EscalationPayloadSchema,
  CloudInferenceVerdictSchema,
  ClientInferenceResultSchema,
  LogoGroundingSpecSchema,
  MultimodalDatasetSampleSchema,
  DatasetProvenanceSchema,
  DatasetManifestSchema,
  SOTABenchmarkReportSchema,
  ExtensionUpdateChannelSchema,
  ExtensionUpdateStatusSchema,
  ExtensionReleaseMetaSchema,
  WarningPresentationTypeSchema,
  ExtensionWarningConfigSchema,
} from './index.js';

describe('PhishGuard Shared Types (Zod / TS)', () => {
  it('validates a correct PointerEventPoint', () => {
    const point = {
      x: 0.45,
      y: 0.72,
      dx: 3.5,
      dy: -1.2,
      velocity: 0.38,
      acceleration: 0.02,
      angle: -0.33,
      timestamp: 120,
      eventType: 'move',
    };
    const parsed = PointerEventPointSchema.parse(point);
    assert.equal(parsed.x, 0.45);
    assert.equal(parsed.eventType, 'move');
  });

  it('rejects an invalid pointer coordinate out of [0, 1]', () => {
    const invalidPoint = {
      x: 1.45,
      y: 0.72,
      dx: 0,
      dy: 0,
      velocity: 0,
      acceleration: 0,
      angle: 0,
      timestamp: 100,
      eventType: 'move',
    };
    assert.throws(() => PointerEventPointSchema.parse(invalidPoint));
  });

  it('validates privacy-preserving KeystrokeDynamics', () => {
    const keystroke = {
      category: 'ALPHANUMERIC',
      dwellTimeMs: 85,
      flightTimeMs: 140,
      timestamp: 500,
    };
    const parsed = KeystrokeDynamicsSchema.parse(keystroke);
    assert.equal(parsed.category, 'ALPHANUMERIC');
  });

  it('validates a complete EscalationPayload and CloudInferenceVerdict', () => {
    const escalation = {
      telemetryId: 'a1b2c3d4-e5f6-4a1b-9c2d-123456789abc',
      url: 'https://security-verify-login.example.com',
      domain: 'security-verify-login.example.com',
      clientRiskScore: 0.65,
      screenshotBase64: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=',
      mouseTrajectorySeries: [
        {
          x: 0.2,
          y: 0.3,
          dx: 1.0,
          dy: 0.5,
          velocity: 0.15,
          acceleration: 0.01,
          angle: 0.46,
          timestamp: 50,
          eventType: 'move',
        },
      ],
      domElementsSummary: [
        {
          eventType: 'click',
          targetBoundingBox: { x: 100, y: 200, width: 250, height: 40 },
          isZeroOpacity: false,
          isCrossOriginIframe: true,
          isPasswordInput: true,
          isPasteIntoPassword: false,
          elementSelector: 'form#login > iframe > input#passwd',
          timestamp: 850,
        },
      ],
      keystrokesSummary: [
        {
          category: 'ALPHANUMERIC',
          dwellTimeMs: 70,
          flightTimeMs: 120,
          timestamp: 950,
        },
      ],
      clientTimestamp: '2026-10-04T12:00:00.000Z',
    };
    const parsedEscalation = EscalationPayloadSchema.parse(escalation);
    assert.equal(parsedEscalation.clientRiskScore, 0.65);

    const verdict = {
      analysisId: 'f0e1d2c3-b4a5-4987-8765-fedcba987654',
      telemetryId: parsedEscalation.telemetryId,
      isPhishing: true,
      targetBrand: 'Microsoft',
      confidence: 0.94,
      actionOverride: 'BLOCK',
      explanationReasons: [
        'Detected credential solicitation inside cross-origin iframe',
        'Visual similarity to Microsoft login page on unregistered domain',
      ],
      teacherModelVersion: 'phishguard-teacher-siglip-v1.0',
      evaluatedAt: '2026-10-04T12:00:01.500Z',
    };
    const parsedVerdict = CloudInferenceVerdictSchema.parse(verdict);
    assert.equal(parsedVerdict.isPhishing, true);
    assert.equal(parsedVerdict.targetBrand, 'Microsoft');
  });

  it('validates MultimodalDatasetSample and SOTABenchmarkReport schemas', () => {
    const sample = {
      sampleId: 'a1b2c3d4-e5f6-4a1b-9c2d-123456789abc',
      label: 1.0,
      url: 'https://login-microsoft-secure.auth-verify.xyz/signin',
      domain: 'auth-verify.xyz',
      targetBrand: 'Microsoft',
      logoDetections: [
        {
          brandName: 'Microsoft',
          brandId: 0,
          boundingBox: { x: 0.05, y: 0.05, width: 0.15, height: 0.08 },
          confidence: 0.98,
          domainMatchesBrand: false,
        },
      ],
      imageDetections: [
        {
          category: 'input_credential',
          boundingBox: { x: 0.2, y: 0.4, width: 0.6, height: 0.06 },
          confidence: 0.95,
        },
      ],
      createdAt: '2026-10-07T12:00:00.000Z',
    };
    const parsedSample = MultimodalDatasetSampleSchema.parse(sample);
    assert.equal(parsedSample.label, 1.0);
    assert.equal(parsedSample.targetBrand, 'Microsoft');

    const manifest = {
      datasetName: 'phishguard-multimodal-sota',
      datasetVersion: '1.0.0',
      createdAt: '2026-10-07T12:00:00.000Z',
      totalSamples: 1000,
      splits: {
        train: {
          totalSamples: 700,
          phishingSamples: 350,
          benignSamples: 350,
          samplesWithLogo: 400,
          samplesWithScreenshot: 700,
        },
      },
      modalitiesSupported: ['url', 'hid_input', 'logo', 'screen', 'image_detection'],
      sotaBenchmarkTargets: {
        min_accuracy: 0.985,
        min_precision: 0.985,
        min_recall: 0.98,
        min_f1: 0.982,
        max_fpr: 0.005,
      },
      featureDimensions: {
        url: 32,
        hid: 16,
        logo: 16,
        detection: 16,
        viewport_h: 224,
        viewport_w: 224,
      },
    };
    const parsedManifest = DatasetManifestSchema.parse(manifest);
    assert.equal(parsedManifest.totalSamples, 1000);

    const report = {
      modelName: 'phishguard-sota-unified-v1',
      evaluatedAt: '2026-10-07T12:00:00.000Z',
      datasetVersion: '1.0.0',
      passedSotaBenchmark: true,
      accuracy: 0.992,
      precision: 0.991,
      recall: 0.993,
      f1Score: 0.992,
      falsePositiveRate: 0.003,
      rocAuc: 0.998,
      brierScore: 0.021,
      latencyMsAvg: 12.4,
      benchmarkThresholds: manifest.sotaBenchmarkTargets,
      gateFailures: [],
    };
    const parsedReport = SOTABenchmarkReportSchema.parse(report);
    assert.equal(parsedReport.passedSotaBenchmark, true);
    assert.equal(parsedReport.accuracy, 0.992);
  });

  it('accepts feed and research provenance values and rejects unknown ones', () => {
    const feed = DatasetProvenanceSchema.parse({
      sourceType: 'public_feed',
      labelSource: 'verified_feed',
      labelConfidence: 0.97,
      labelReason: 'OpenPhish community feed listing',
      modalities: { url: 'observed' },
    });
    assert.equal(feed.sourceType, 'public_feed');
    assert.equal(feed.labelSource, 'verified_feed');

    const research = DatasetProvenanceSchema.parse({
      sourceType: 'research_agent',
      labelSource: 'llm_research',
      labelConfidence: 0.6,
      labelReason: 'Deep Research (new_phishing_datasets): vendor IOC report',
      modalities: { url: 'observed' },
    });
    assert.equal(research.sourceType, 'research_agent');
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

  it('validates extension update channel, native readiness and webstore release fields', () => {
    assert.equal(ExtensionUpdateChannelSchema.parse('NATIVE'), 'NATIVE');
    assert.throws(() => ExtensionUpdateChannelSchema.parse('BOGUS'));

    const status = ExtensionUpdateStatusSchema.parse({
      currentVersion: '0.3.0',
      latestVersion: '0.3.1',
      updateAvailable: true,
      lastChecked: '2026-10-09T12:00:00.000Z',
      checkMethod: 'NATIVE_RUNTIME',
      backendReachable: true,
      updateChannel: 'NATIVE',
      nativeUpdateReady: true,
    });
    assert.equal(status.updateChannel, 'NATIVE');
    assert.equal(status.nativeUpdateReady, true);

    const defaults = ExtensionUpdateStatusSchema.parse({
      currentVersion: '0.3.0',
      latestVersion: '0.3.0',
      updateAvailable: false,
      lastChecked: '2026-10-09T12:00:00.000Z',
      checkMethod: 'API_POLL',
      backendReachable: true,
    });
    assert.equal(defaults.nativeUpdateReady, false);
    assert.equal(defaults.updateChannel, undefined);

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

  it('validates warning presentation type and extension warning config', () => {
    assert.equal(WarningPresentationTypeSchema.parse('smart'), 'smart');
    assert.equal(WarningPresentationTypeSchema.parse('overlay'), 'overlay');
    assert.equal(WarningPresentationTypeSchema.parse('banner'), 'banner');
    assert.equal(WarningPresentationTypeSchema.parse('notification'), 'notification');
    assert.throws(() => WarningPresentationTypeSchema.parse('invalid_type'));

    const defaultConfig = ExtensionWarningConfigSchema.parse({});
    assert.equal(defaultConfig.warningType, 'smart');
    assert.equal(defaultConfig.snoozeDurationMinutes, 15);
    assert.deepEqual(defaultConfig.snoozedDomains, {});
    assert.deepEqual(defaultConfig.acknowledgedDomains, {});

    const customConfig = ExtensionWarningConfigSchema.parse({
      warningType: 'banner',
      snoozeDurationMinutes: 60,
      snoozedDomains: { 'test.example.com': 1760000000000 },
      acknowledgedDomains: { 'trusted.example.com': 1760000000000 },
    });
    assert.equal(customConfig.warningType, 'banner');
    assert.equal(customConfig.snoozeDurationMinutes, 60);
    assert.equal(customConfig.snoozedDomains['test.example.com'], 1760000000000);
  });
});

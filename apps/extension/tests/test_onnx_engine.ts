import test from 'node:test';
import assert from 'node:assert/strict';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import { PAGE_CONTEXT_FEATURES, preparePageContext } from '../src/background/page-context.ts';
import { prepareTrajectory } from '../src/background/trajectory-preprocessor.ts';
import type { ModelMetadata, PointerEventPoint } from '@phishguard/types';

test('ORT wasm setup assigns the fetched buffer directly and retries after a failed fetch', async () => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const original = { chrome: globalScope.chrome, fetch: globalScope.fetch };
  const wasmFetches: string[] = [];
  const fetchedBuffer = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
  let serveWasm = false;
  globalScope.chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  globalScope.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('ort-wasm-simd-threaded.wasm')) {
      wasmFetches.push(url);
      if (serveWasm) {
        return { ok: true, status: 200, arrayBuffer: async () => fetchedBuffer } as Response;
      }
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
  };
  const ort = await import('onnxruntime-web/wasm');
  const wasmBinaryBefore = ort.env.wasm.wasmBinary;
  try {
    const failing = new OnDeviceStudentEngine();
    failing.hotSwapModel = async () => true;
    await failing.initialize();
    // Every candidate path was tried; the failed fetch leaves wasmBinary
    // untouched and is not memoized as a completed setup.
    assert.equal(wasmFetches.length, 2);
    assert.equal(ort.env.wasm.wasmBinary, wasmBinaryBefore);

    serveWasm = true;
    const retrying = new OnDeviceStudentEngine();
    retrying.hotSwapModel = async () => true;
    await retrying.initialize();
    assert.ok(wasmFetches.length >= 3, 'retry re-fetches the wasm binary');
    // The fetched buffer is assigned directly — no cached copy, no slice().
    assert.equal(ort.env.wasm.wasmBinary, fetchedBuffer);
  } finally {
    if (original.chrome === undefined) delete globalScope.chrome;
    else globalScope.chrome = original.chrome;
    if (original.fetch === undefined) delete globalScope.fetch;
    else globalScope.fetch = original.fetch;
  }
});

test('OnDeviceStudentEngine preprocesses trajectory to (128, 6) Float32Array', () => {
  const engine = new OnDeviceStudentEngine();
  const samplePoints: PointerEventPoint[] = [
    { x: 0.1, y: 0.2, dx: 1.0, dy: 0.5, velocity: 0.2, acceleration: 0.01, angle: 0.46, timestamp: 10, eventType: 'down' },
    { x: 0.3, y: 0.4, dx: 2.0, dy: 1.5, velocity: 0.3, acceleration: 0.02, angle: 0.64, timestamp: 30, eventType: 'move' },
    { x: 0.8, y: 0.9, dx: 5.0, dy: 4.5, velocity: 0.5, acceleration: 0.01, angle: 0.72, timestamp: 60, eventType: 'up' },
  ];

  const processed = engine.preprocessTrajectory(samplePoints);
  assert.equal(processed.length, 128 * 6);
  assert.ok(processed instanceof Float32Array);

  // Check first point features: [x, y, dx, dy, v, theta]
  assert.ok(Math.abs(processed[0] - 0.1) < 1e-5);
  assert.ok(Math.abs(processed[1] - 0.2) < 1e-5);

  // Check last point
  assert.ok(Math.abs(processed[127 * 6] - 0.8) < 1e-5);
  assert.ok(Math.abs(processed[127 * 6 + 1] - 0.9) < 1e-5);
});

test('OnDeviceStudentEngine routes benign and independently corroborated control traps', async () => {
  const engine = new OnDeviceStudentEngine();

  // 1. Safe Benign interaction
  const benignPayload = {
    telemetryId: '11111111-1111-1111-1111-111111111111',
    url: 'https://example.com',
    domain: 'example.com',
    pageTitle: 'Home',
    sessionDurationMs: 1000,
    pointerSeries: [
      { x: 0.1, y: 0.1, dx: 0.1, dy: 0.1, velocity: 0.01, acceleration: 0.0, angle: 0.1, timestamp: 10, eventType: 'move' as const },
    ],
    keystrokes: [],
    domEvents: [],
    hasCredentialField: false,
    clientTimestamp: new Date().toISOString(),
  };

  const benignResult = await engine.predict(benignPayload);
  assert.equal(benignResult.routeAction, 'SAFE');
  assert.ok(benignResult.clientRiskScore < 0.15);

  // 2. High-Risk interaction (opacity 0 + password in cross-origin iframe)
  const suspiciousPayload = {
    telemetryId: '22222222-2222-2222-2222-222222222222',
    url: 'https://suspicious-site.cc',
    domain: 'suspicious-site.cc',
    pageTitle: 'Security Verification',
    sessionDurationMs: 2000,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [
      domEvent({
        evidenceSource: 'topology_scan',
        evidenceId: 'control-password',
        isZeroOpacity: true,
        isHitTestIntercepting: true,
        coveredControlType: 'password',
      }),
      domEvent({
        evidenceSource: 'topology_scan',
        evidenceId: 'control-submit',
        isZeroOpacity: true,
        isHitTestIntercepting: true,
        coveredControlType: 'submit',
      }),
    ],
    hasCredentialField: true,
    clientTimestamp: new Date().toISOString(),
  };

  const suspiciousResult = await engine.predict(suspiciousPayload);
  assert.equal(suspiciousResult.routeAction, 'BLOCK');
  assert.ok(suspiciousResult.clientRiskScore > 0.85);
});

function domEvent(overrides: Partial<{
  isZeroOpacity: boolean;
  isCrossOriginIframe: boolean;
  isPasswordInput: boolean;
  isPasteIntoPassword: boolean;
  evidenceSource: 'observed_interaction' | 'topology_scan' | 'legacy';
  evidenceId: string;
  isHitTestIntercepting: boolean;
  coveredControlType: 'password' | 'submit' | 'other' | 'none';
  credentialFrameEvidence: 'observed' | 'unverified' | 'none';
}>) {
  return {
    eventType: 'click' as const,
    targetBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'div#target',
    timestamp: 500,
    evidenceSource: 'legacy' as const,
    evidenceId: 'fixture-target',
    isHitTestIntercepting: false,
    coveredControlType: 'none' as const,
    credentialFrameEvidence: 'none' as const,
    ...overrides,
  };
}

function fixturePayload(domEvents: ReturnType<typeof domEvent>[]) {
  return {
    telemetryId: '33333333-3333-3333-3333-333333333333',
    url: 'https://example.test',
    domain: 'example.test',
    pageTitle: 'Fixture',
    sessionDurationMs: 1000,
    pointerSeries: [],
    keystrokes: [],
    domEvents,
    hasCredentialField: false,
    clientTimestamp: new Date().toISOString(),
  };
}

test('predictDetailed keeps fused score and routing identical to predict for benign, ambiguous and blocked inputs', async () => {
  const engine = new OnDeviceStudentEngine();
  const cases = [
    { name: 'benign', events: [], score: 0.05, action: 'SAFE', anomalies: 0, detail: 'No verified page evidence' },
    {
      name: 'normal-paste',
      events: [domEvent({ isPasteIntoPassword: true })],
      score: 0.05,
      action: 'SAFE',
      anomalies: 0,
      detail: 'No verified page evidence',
    },
    {
      name: 'blocked',
      events: [
        domEvent({
          evidenceSource: 'topology_scan',
          evidenceId: 'password-control',
          isZeroOpacity: true,
          isHitTestIntercepting: true,
          coveredControlType: 'password',
        }),
        domEvent({
          evidenceSource: 'topology_scan',
          evidenceId: 'submit-control',
          isZeroOpacity: true,
          isHitTestIntercepting: true,
          coveredControlType: 'submit',
        }),
      ],
      score: 0.9,
      action: 'BLOCK',
      anomalies: 2,
      detail: 'A persistent transparent overlay intercepts an interactive control · Distinct transparent traps intercept credential and submission controls',
    },
  ] as const;

  for (const c of cases) {
    const payload = fixturePayload([...c.events]);
    const plain = await engine.predict(payload);
    const detailed = await engine.predictDetailed(payload);

    assert.equal(plain.clientRiskScore, c.score, `${c.name}: predict score`);
    assert.equal(detailed.result.clientRiskScore, c.score, `${c.name}: predictDetailed score`);
    assert.equal(detailed.result.routeAction, c.action, `${c.name}: route`);
    assert.equal(detailed.breakdown.page.anomalies, c.anomalies, `${c.name}: anomalies`);
    assert.equal(detailed.breakdown.page.detail, c.detail, `${c.name}: page detail`);
    assert.equal(detailed.breakdown.page.status, c.anomalies > 0 ? 'flag' : 'ok');
    assert.equal(detailed.breakdown.interaction.status, 'skipped');
    assert.equal(detailed.breakdown.interaction.detail, 'Behavioral input unavailable · empty');
    assert.equal(detailed.breakdown.vision.status, 'skipped');
    assert.equal(detailed.breakdown.vision.detail, 'Visual capture failed; page analysis continued');
  }
});

test('legacy and unverified foreign-frame events do not become verified interception evidence', async () => {
  const engine = new OnDeviceStudentEngine();
  const payload = fixturePayload([
    domEvent({ isZeroOpacity: true }),
    domEvent({
      isCrossOriginIframe: true,
      isPasswordInput: false,
      credentialFrameEvidence: 'unverified',
    }),
  ]);
  const { result, breakdown } = await engine.predictDetailed(payload);
  assert.equal(breakdown.page.anomalies, 0);
  assert.equal(breakdown.page.detail, 'No verified page evidence');
  assert.equal(result.clientRiskScore, 0.05);
  assert.equal(result.routeAction, 'SAFE');
});

test('brand mentions in path and query do not create evidence-only risk', async () => {
  const engine = new OnDeviceStudentEngine();
  const payload = {
    ...fixturePayload([]),
    url: 'https://unauthorized-host.net/auth/paypal-login.php?session=active',
    domain: 'unauthorized-host.net',
  };
  const { result, breakdown } = await engine.predictDetailed(payload);
  assert.equal(breakdown.page.anomalies, 0);
  assert.equal(breakdown.page.status, 'ok');
  assert.equal(breakdown.page.detail, 'No verified page evidence');
  assert.equal(result.routeAction, 'SAFE');
  assert.equal(result.clientRiskScore, 0.05);
});

test('parsed URL authority userinfo is distinguished from an @ in a path or query', async () => {
  const engine = new OnDeviceStudentEngine();
  const payload = {
    ...fixturePayload([]),
    url: 'https://accounts.google.com@evil-phish.biz/login',
    domain: 'evil-phish.biz',
  };
  const { result, breakdown } = await engine.predictDetailed(payload);
  assert.equal(breakdown.page.status, 'flag');
  assert.equal(breakdown.page.detail, 'The URL contains an authority userinfo separator');
  assert.equal(result.clientRiskScore, 0.4);
  assert.equal(result.routeAction, 'AMBIGUOUS');
});

test('HTTP and HTTPS page contexts differ only by transport without changing benign evidence routing', async () => {
  const base = fixturePayload([]);
  const prepared = prepareTrajectory([]);
  const httpPayload = { ...base, url: 'http://example.test/login' };
  const httpsPayload = { ...base, url: 'https://example.test/login' };
  const httpPage = preparePageContext(httpPayload, prepared, false);
  const httpsPage = preparePageContext(httpsPayload, prepared, false);

  assert.equal(httpPage.available, true);
  assert.equal(httpsPage.available, true);
  assert.deepEqual([...httpPage.context.slice(0, 15)], [...httpsPage.context.slice(0, 15)]);
  assert.equal(httpPage.context[15], 0);
  assert.equal(httpsPage.context[15], 1);

  const engine = new OnDeviceStudentEngine();
  const httpResult = await engine.predictDetailed(httpPayload);
  const httpsResult = await engine.predictDetailed(httpsPayload);
  assert.equal(httpResult.result.clientRiskScore, 0.05);
  assert.equal(httpsResult.result.clientRiskScore, 0.05);
  assert.equal(httpResult.result.routeAction, 'SAFE');
  assert.equal(httpsResult.result.routeAction, 'SAFE');
});

function usablePoints(): PointerEventPoint[] {
  return Array.from({ length: 16 }, (_, index) => ({
    x: 0.1 + index * 0.01,
    y: 0.2 + index * 0.005,
    dx: 25,
    dy: 12.5,
    velocity: 0.3,
    acceleration: 0,
    angle: 0.46,
    timestamp: index * 10,
    eventType: 'move' as const,
  }));
}

function attachSession(
  engine: OnDeviceStudentEngine,
  inputNames: string[],
  outputValue: number
): Array<Record<string, { dims: number[]; data: Float32Array }>> {
  const feedsSeen: Array<Record<string, { dims: number[]; data: Float32Array }>> = [];
  const internals = engine as unknown as { session: unknown; isLoaded: boolean };
  internals.session = {
    inputNames,
    outputNames: ['risk_score'],
    run: async (feeds: Record<string, { dims: number[]; data: Float32Array }>) => {
      // Feed tensors are disposed once the graph run completes; snapshot
      // their contents inside the run while they are still valid.
      const snapshot: Record<string, { dims: number[]; data: Float32Array }> = {};
      for (const [name, tensor] of Object.entries(feeds)) {
        snapshot[name] = { dims: [...tensor.dims], data: new Float32Array(tensor.data) };
      }
      feedsSeen.push(snapshot);
      return { risk_score: { data: new Float32Array([outputValue]) } };
    },
  };
  internals.isLoaded = true;
  return feedsSeen;
}

test('student-v2 receives exact named feeds and unavailable modality masks', async () => {
  const engine = new OnDeviceStudentEngine();
  const feedsSeen = attachSession(engine, ['trajectory', 'visual', 'page_context'], 0.91);
  const { result, breakdown } = await engine.predictDetailed(fixturePayload([]), null);

  assert.equal(feedsSeen.length, 1);
  assert.deepEqual(Object.keys(feedsSeen[0]).sort(), ['page_context', 'trajectory', 'visual']);
  assert.deepEqual(feedsSeen[0].trajectory.dims, [1, 128, 6]);
  assert.deepEqual(feedsSeen[0].visual.dims, [1, 3, 64, 64]);
  assert.deepEqual(feedsSeen[0].page_context.dims, [1, 16]);
  assert.ok(feedsSeen[0].trajectory.data.every((value) => value === 0));
  assert.ok(feedsSeen[0].visual.data.every((value) => value === 0));
  assert.equal(feedsSeen[0].page_context.data[12], 0);
  assert.equal(feedsSeen[0].page_context.data[13], 0);
  assert.equal(feedsSeen[0].page_context.data[14], 1);
  assert.equal(result.clientRiskScore, 0.91);
  assert.equal(result.routeAction, 'BLOCK');
  assert.equal(breakdown.fused.modelStatus, 'available');
  assert.equal(breakdown.fused.modelContract, 'student-v2');
  assert.ok(breakdown.fused.reasons.includes('On-device multimodal model detected high risk'));
});

test('v1 model inference requires a usable trajectory and normalizes its kinematic channels', async () => {
  const engine = new OnDeviceStudentEngine();
  const feedsSeen = attachSession(engine, ['visual', 'trajectory'], 0.4);
  const missing = await engine.predictDetailed(fixturePayload([]), new Float32Array(3 * 64 * 64).fill(0.5));
  assert.equal(missing.breakdown.fused.modelStatus, 'unavailable');
  assert.equal(feedsSeen.length, 0);

  const payload = { ...fixturePayload([]), pointerSeries: usablePoints() };
  const frame = new Float32Array(3 * 64 * 64).fill(0.5);
  const usable = await engine.predictDetailed(payload, frame);
  assert.equal(feedsSeen.length, 1);
  assert.deepEqual(Object.keys(feedsSeen[0]).sort(), ['trajectory', 'visual']);
  const modelDx = feedsSeen[0].trajectory.data[6 + 2] as number;
  assert.ok(modelDx > 0 && modelDx < 0.01);
  assert.ok(Math.abs((usable.breakdown.fused.modelScore ?? 0) - 0.4) < 1e-6);
  assert.equal(usable.breakdown.vision.score, null);
});

test('non-finite and out-of-range model outputs fall back to evidence-only composition', async () => {
  for (const invalidOutput of [Number.NaN, Number.POSITIVE_INFINITY, 1.01]) {
    const engine = new OnDeviceStudentEngine();
    attachSession(engine, ['trajectory', 'visual', 'page_context'], invalidOutput);
    const { result, breakdown } = await engine.predictDetailed(fixturePayload([]));
    assert.equal(result.clientRiskScore, 0.05);
    assert.equal(result.routeAction, 'SAFE');
    assert.equal(breakdown.fused.modelStatus, 'unavailable');
    assert.equal(breakdown.fused.modelScore, null);
  }
});

test('student-v2 skips model inference when the page context cannot be validated', async () => {
  const engine = new OnDeviceStudentEngine();
  const feedsSeen = attachSession(engine, ['trajectory', 'visual', 'page_context'], 0.99);
  const payload = {
    ...fixturePayload([]),
    domain: 'different.example',
  };
  const { result, breakdown } = await engine.predictDetailed(payload);
  assert.equal(feedsSeen.length, 0);
  assert.equal(breakdown.fused.modelScore, null);
  assert.equal(breakdown.fused.modelStatus, 'unavailable');
  assert.equal(breakdown.page.status, 'skipped');
  assert.equal(result.clientRiskScore, 0.05);
  assert.equal(result.routeAction, 'SAFE');
});

test('incomplete topology scans are not reported as verified clean pages', async () => {
  const engine = new OnDeviceStudentEngine();
  const { breakdown } = await engine.predictDetailed(
    fixturePayload([]),
    null,
    { topologyScanComplete: false }
  );
  assert.equal(breakdown.page.status, 'skipped');
  assert.match(breakdown.page.detail, /Topology scan incomplete/);
  assert.equal(breakdown.fused.coverage.topologyScanComplete, false);
});

test('inference retains the session and model identity captured at prediction start', async () => {
  const engine = new OnDeviceStudentEngine();
  let startRun: (() => void) | undefined;
  let finishRun: ((value: number) => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    startRun = resolve;
  });
  const runFinished = new Promise<number>((resolve) => {
    finishRun = resolve;
  });
  const original = {
    inputNames: ['trajectory', 'visual', 'page_context'],
    outputNames: ['risk_score'],
    run: async () => {
      startRun?.();
      return { risk_score: { data: new Float32Array([await runFinished]) } };
    },
  };
  const replacement = {
    inputNames: ['trajectory', 'visual', 'page_context'],
    outputNames: ['risk_score'],
    run: async () => ({ risk_score: { data: new Float32Array([0.1]) } }),
  };
  const internals = engine as unknown as {
    session: unknown;
    isLoaded: boolean;
    activeVersion: string;
    activeMetadata: unknown;
  };
  internals.session = original;
  internals.isLoaded = true;
  internals.activeVersion = 'candidate-a';
  internals.activeMetadata = { version: 'candidate-a', sha256: 'a'.repeat(64) };

  const inference = engine.predictDetailed(fixturePayload([]));
  await runStarted;
  internals.session = replacement;
  internals.activeVersion = 'candidate-b';
  internals.activeMetadata = { version: 'candidate-b', sha256: 'b'.repeat(64) };
  finishRun?.(0.9);
  const { result, breakdown } = await inference;

  assert.equal(result.modelVersion, 'vcandidate-a');
  assert.equal(breakdown.fused.modelVersion, 'candidate-a');
  assert.equal(breakdown.fused.modelHash, 'a'.repeat(64));
  assert.ok(Math.abs((breakdown.fused.modelScore ?? 0) - 0.9) < 1e-6);
});

test('activations are serialized: queued newer session wins, downgrade rejected, retired inference releases safely', async () => {
  const engine = new OnDeviceStudentEngine();
  const created: Array<{ version: string; releases: number }> = [];
  const internals = engine as unknown as {
    createSession: (buffer: ArrayBuffer) => Promise<unknown>;
    validateSessionSignature: () => boolean;
    warmSession: (session: unknown) => Promise<void>;
    runSession: () => Promise<number>;
  };
  let resolveOlderWarm: (() => void) | undefined;
  let notifyOlderWarm: (() => void) | undefined;
  const olderWarmStarted = new Promise<void>((resolve) => {
    notifyOlderWarm = resolve;
  });
  const olderWarmGate = new Promise<void>((resolve) => {
    resolveOlderWarm = resolve;
  });
  let resolveInference: ((value: number) => void) | undefined;
  let notifyInferenceStarted: (() => void) | undefined;
  const inferenceStarted = new Promise<void>((resolve) => {
    notifyInferenceStarted = resolve;
  });
  const inferenceGate = new Promise<number>((resolve) => {
    resolveInference = resolve;
  });
  internals.createSession = async (buffer) => {
    const version = new TextDecoder().decode(buffer);
    const session = {
      version,
      inputNames: ['trajectory'],
      outputNames: ['risk_score'],
      release: async () => {
        const record = created.find((entry) => entry.version === version);
        if (record) record.releases++;
      },
    };
    created.push({ version, releases: 0 });
    return session;
  };
  internals.validateSessionSignature = () => true;
  internals.warmSession = async (session) => {
    if ((session as { version: string }).version === '1.6.0') {
      notifyOlderWarm?.();
      await olderWarmGate;
    }
  };
  internals.runSession = async () => {
    notifyInferenceStarted?.();
    return inferenceGate;
  };

  const candidate = async (version: string) => {
    const buffer = new TextEncoder().encode(version).buffer;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const metadata: ModelMetadata = {
      version,
      name: 'student-test',
      architecture: 'student-test',
      sha256,
      fileSizeBytes: buffer.byteLength,
      releasedAt: new Date().toISOString(),
      minExtensionVersion: '0.1.0',
      features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
      metrics: { accuracy: 0.95, f1Score: 0.95, latencyMs: 1, memoryBudgetMb: 1 },
      changelog: [],
      downloadUrl: '/student-test.onnx',
    };
    return { buffer, metadata };
  };

  const base = await candidate('1.5.0');
  assert.equal(await engine.hotSwapModel(base.buffer, base.metadata), true);
  const inference = engine.predictDetailed({
    ...fixturePayload([]),
    pointerSeries: usablePoints(),
  });
  await inferenceStarted;

  const older = await candidate('1.6.0');
  const olderActivation = engine.hotSwapModel(older.buffer, older.metadata);
  await olderWarmStarted;
  // Activations are serialized: the newer request queues behind the older
  // warmup instead of racing it, so resolve the older warmup first.
  const newer = await candidate('1.7.0');
  const newerActivation = engine.hotSwapModel(newer.buffer, newer.metadata);
  resolveOlderWarm?.();
  assert.equal(await olderActivation, true);
  assert.equal(await newerActivation, true);
  assert.equal(engine.getActiveVersion(), '1.7.0');
  assert.equal(engine.isReady(), true);
  // The superseded 1.6.0 session is retired once 1.7.0 swaps in; the 1.5.0
  // session is still retained by the in-flight inference.
  assert.equal(created.find((entry) => entry.version === '1.6.0')?.releases, 1);
  assert.equal(created.find((entry) => entry.version === '1.5.0')?.releases, 0);

  // A downgrade request after the newer activation is rejected before any
  // expensive session work.
  const stale = await candidate('1.6.0');
  assert.equal(await engine.hotSwapModel(stale.buffer, stale.metadata), false);
  assert.equal(engine.getActiveVersion(), '1.7.0');

  resolveInference?.(0.1);
  await inference;
  assert.equal(created.find((entry) => entry.version === '1.5.0')?.releases, 1);
});

test('student-v2 activation requires canonical tensor shapes and bounded validation metadata', () => {
  const engine = new OnDeviceStudentEngine();
  const internal = engine as unknown as {
    validateSessionSignature: (session: unknown, metadata: unknown) => boolean;
  };
  const sha256 = 'a'.repeat(64);
  const contract = {
    identifier: 'student-v2',
    trajectoryPreprocessing: 'normalized-coordinate-derivatives-index-linear-v2',
    inputs: [
      { name: 'trajectory', dtype: 'float32', shape: [128, 6] },
      { name: 'visual', dtype: 'float32', shape: [3, 64, 64] },
      { name: 'page_context', dtype: 'float32', shape: [16] },
    ],
    contextFeatures: [...PAGE_CONTEXT_FEATURES],
  };
  const metadata = {
    version: 'candidate-test',
    sha256,
    inputContract: contract,
    validationSummary: {
      passedAllGates: true,
      modelSha256: sha256,
      inputContractIdentifier: 'student-v2',
      policyVersion: 'evidence-v2',
      falsePositiveRate: 0.005,
      benignWarningCount: 0,
      criticalMissCount: 0,
    },
  } as unknown as ModelMetadata;
  const makeSession = (
    shapes: Record<string, Array<number | string>>
  ) => ({
    inputNames: ['trajectory', 'visual', 'page_context'],
    inputMetadata: Object.entries(shapes).map(([name, shape]) => ({
      name,
      isTensor: true as const,
      type: 'float32' as const,
      shape,
    })),
    outputNames: ['risk_score'],
    outputMetadata: [{
      name: 'risk_score',
      isTensor: true as const,
      type: 'float32' as const,
      shape: ['batch_size', 1],
    }],
  });
  const canonical = makeSession({
    trajectory: ['batch_size', 128, 6],
    visual: ['batch_size', 3, 64, 64],
    page_context: ['batch_size', 16],
  });
  assert.equal(internal.validateSessionSignature(canonical, metadata), true);

  const wrongTrajectoryContract = {
    ...metadata,
    inputContract: {
      ...contract,
      inputs: contract.inputs.map((input) =>
        input.name === 'trajectory' ? { ...input, shape: [256, 6] } : input
      ),
    },
  };
  assert.equal(
    internal.validateSessionSignature(makeSession({
      trajectory: ['batch_size', 256, 6],
      visual: ['batch_size', 3, 64, 64],
      page_context: ['batch_size', 16],
    }), wrongTrajectoryContract),
    false,
  );

  const wrongVisualGraph = makeSession({
    trajectory: ['batch_size', 128, 6],
    visual: ['batch_size', 3, 128, 128],
    page_context: ['batch_size', 16],
  });
  assert.equal(internal.validateSessionSignature(wrongVisualGraph, metadata), false);
  const excessiveFpr = {
    ...metadata,
    validationSummary: { ...metadata.validationSummary, falsePositiveRate: 0.0051 },
  };
  assert.equal(internal.validateSessionSignature(canonical, excessiveFpr), false);
});

test('graph execution is serialized so only one session.run executes at a time', async () => {
  const engine = new OnDeviceStudentEngine();
  const internals = engine as unknown as { session: unknown; isLoaded: boolean };
  let firstStarted!: () => void;
  let finishFirst!: (value: number) => void;
  let secondStarted = false;
  const firstRunStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstRunGate = new Promise<number>((resolve) => {
    finishFirst = resolve;
  });
  const secondRunStarted = new Promise<void>((resolve) => {
    let runs = 0;
    internals.session = {
      inputNames: ['trajectory', 'visual', 'page_context'],
      outputNames: ['risk_score'],
      run: async () => {
        runs++;
        if (runs === 1) {
          firstStarted();
          return { risk_score: { data: new Float32Array([await firstRunGate]) } };
        }
        secondStarted = true;
        resolve();
        return { risk_score: { data: new Float32Array([0.2]) } };
      },
    };
  });
  internals.isLoaded = true;

  const first = engine.predictDetailed(fixturePayload([]));
  await firstRunStarted;
  const second = engine.predictDetailed(fixturePayload([]));
  // Give the queued run a chance to enter the gate; it must not start.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondStarted, false);
  finishFirst(0.9);
  const [firstOutcome] = await Promise.all([first, second]);
  await secondRunStarted;
  assert.ok(Math.abs((firstOutcome.breakdown.fused.modelScore ?? 0) - 0.9) < 1e-6);
});

test('input and output tensors are disposed on success and on failure', async () => {
  const { Tensor } = await import('onnxruntime-web/wasm');
  const originalDispose = Tensor.prototype.dispose;
  let disposedInputs = 0;
  Tensor.prototype.dispose = function () {
    disposedInputs++;
    return originalDispose.call(this);
  };
  try {
    const successSession = {
      inputNames: ['trajectory', 'visual', 'page_context'],
      outputNames: ['risk_score'],
      run: async () => ({
        risk_score: { data: new Float32Array([0.5]), dispose: () => disposedOutputs++ },
      }),
    };
    let disposedOutputs = 0;
    const internalsOf = (engine: OnDeviceStudentEngine) =>
      engine as unknown as { session: unknown; isLoaded: boolean };
    const okEngine = new OnDeviceStudentEngine();
    internalsOf(okEngine).session = successSession;
    internalsOf(okEngine).isLoaded = true;
    await okEngine.predictDetailed(fixturePayload([]));
    assert.equal(disposedInputs, 3);
    assert.equal(disposedOutputs, 1);

    disposedInputs = 0;
    const failingEngine = new OnDeviceStudentEngine();
    internalsOf(failingEngine).session = {
      inputNames: ['trajectory', 'visual', 'page_context'],
      outputNames: ['risk_score'],
      run: async () => {
        throw new Error('graph failure');
      },
    };
    internalsOf(failingEngine).isLoaded = true;
    const { breakdown } = await failingEngine.predictDetailed(fixturePayload([]));
    assert.equal(disposedInputs, 3);
    assert.equal(breakdown.fused.modelStatus, 'unavailable');
  } finally {
    Tensor.prototype.dispose = originalDispose;
  }
});

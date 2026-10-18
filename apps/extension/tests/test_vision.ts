import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import {
  CAPTURE_INTERVAL_MS,
  CAPTURE_MIN_SPACING_MS,
  captureScreenshotForUpload,
  UPLOAD_MAX_BYTES,
  captureVisualTensor,
  captureVisualTensorWithStatus,
  resetVisionRateLimit,
  rgbaToChwTensor,
} from '../src/background/vision-capture.ts';
import {
  engine as serviceWorkerEngine,
  handleManualEscalation,
  handleTelemetryEvaluation,
  handleTabUpdated,
  tabAnalysisStore,
  tabVisionCache,
} from '../src/background/service-worker.ts';
import type { PageEvaluationEnvelope } from '../src/background/tab-analysis-state.ts';
import { sqliteStorage } from '../src/background/sqlite-storage.ts';
import type { VisionCaptureState, VisionUnavailableReason } from '../src/background/types.ts';
import type { InteractionTelemetryPayload } from '@phishguard/types';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/viewport_8x8.json', import.meta.url), 'utf8')
) as { width: number; height: number; rgba: number[]; expected: number[] };

interface ChromeMockOptions {
  active?: boolean;
  focused?: boolean;
  windowState?: string;
  url?: string;
  windowId?: number;
  warningVisible?: boolean;
  captureFailure?: boolean;
  decodeFailure?: boolean;
  canvasFailure?: boolean;
  canvasContextUnavailable?: boolean;
  afterImageRead?: () => void;
  afterScreenshotEncode?: () => void;
  afterTabGet?: (readCount: number, tabId: number) => void;
  bitmapSize?: { width: number; height: number };
  encodedSizes?: number[];
}

function setupCaptureEnvironment(options: ChromeMockOptions = {}) {
  const {
    active = true,
    focused = true,
    windowState = 'normal',
    url = 'https://example.com/login',
    windowId = 7,
    warningVisible,
  } = options;
  let currentUrl = url;
  let currentActive = active;
  let currentFocused = focused;
  let currentWindowState = windowState;
  let captureFailure = options.captureFailure ?? false;
  let decodeFailure = options.decodeFailure ?? false;
  let canvasFailure = options.canvasFailure ?? false;
  let canvasContextUnavailable = options.canvasContextUnavailable ?? false;
  let captureApiAvailable = true;
  const bitmapSize = options.bitmapSize ?? { width: 64, height: 64 };
  const encodedSizes = [...(options.encodedSizes ?? [])];
  const canvasSizes: Array<{ width: number; height: number }> = [];
  const encodes: Array<{ type?: string; quality?: number }> = [];
  let afterImageRead = options.afterImageRead;
  let afterScreenshotEncode = options.afterScreenshotEncode;
  let afterTabGet = options.afterTabGet;
  const store: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const storeWrites: unknown[] = [];
  const sessionWrites: unknown[] = [];
  const sentMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  let captureCalls = 0;
  const captureCallTimes: number[] = [];
  let warningVisibleOverride = warningVisible;
  let pageIdentityOverride: unknown;
  let pageIdentityReadCount = 0;
  let tabGetReadCount = 0;
  let afterPageIdentityRead: ((readCount: number, tabId: number) => void) | undefined;
  let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    async () => ({ blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response);

  const g = globalThis as Record<string, unknown>;
  const originalGlobals = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of [
    'chrome',
    'fetch',
    'createImageBitmap',
    'OffscreenCanvas',
  ]) {
    originalGlobals.set(key, {
      existed: Object.prototype.hasOwnProperty.call(g, key),
      value: g[key],
    });
  }
  const captureVisibleTab = async () => {
    captureCalls++;
    captureCallTimes.push(Date.now());
    if (captureFailure) throw new Error('capture rejected');
    return 'data:image/jpeg;base64,AAAA';
  };
  g.chrome = {
    storage: {
      local: {
        get: async (keys: string[] | string) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          const res: Record<string, unknown> = {};
          for (const k of list) if (k in store) res[k] = store[k];
          return res;
        },
        set: async (items: Record<string, unknown>) => {
          storeWrites.push(items);
          Object.assign(store, items);
        },
        remove: async () => {},
      },
      session: {
        get: async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          const res: Record<string, unknown> = {};
          for (const key of list) if (key in sessionStore) res[key] = sessionStore[key];
          return res;
        },
        set: async (items: Record<string, unknown>) => {
          sessionWrites.push(items);
          Object.assign(sessionStore, items);
        },
        remove: async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          for (const key of list) delete sessionStore[key];
        },
      },
    },
    tabs: {
      get: async (tabId: number) => {
        tabGetReadCount++;
        const result = { id: tabId, active: currentActive, windowId, url: currentUrl };
        afterTabGet?.(tabGetReadCount, tabId);
        return result;
      },
      captureVisibleTab,
      sendMessage: (tabId: number, message: Record<string, unknown>, callback?: (response?: unknown) => void) => {
        sentMessages.push({ tabId, message });
        if (message.type === 'GET_PAGE_IDENTITY') {
          pageIdentityReadCount++;
          afterPageIdentityRead?.(pageIdentityReadCount, tabId);
          const snapshot = tabAnalysisStore.get(tabId);
          callback?.(pageIdentityOverride ?? (snapshot ? {
            pageSessionId: snapshot.pageSessionId,
            navigationGeneration: snapshot.navigationGeneration,
            evaluationGeneration: snapshot.evaluationGeneration,
            url: snapshot.url,
            warningVisible: warningVisibleOverride ?? snapshot.warningVisible,
            topologyScanComplete: snapshot.topologyScanComplete,
          } : undefined));
        } else {
          callback?.({ success: true });
        }
      },
    },
    windows: { get: async () => ({ id: windowId, focused: currentFocused, state: currentWindowState }) },
  };
  g.fetch = (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init);
  g.createImageBitmap = async () => {
    if (decodeFailure) throw new Error('decode rejected');
    return { width: bitmapSize.width, height: bitmapSize.height, close: () => {} };
  };
  g.OffscreenCanvas = class {
    constructor(width: number, height: number) {
      canvasSizes.push({ width, height });
    }
    getContext() {
      if (canvasContextUnavailable) return null;
      return {
        drawImage: () => {
          if (canvasFailure) throw new Error('canvas draw failed');
        },
        fillRect: () => {},
        getImageData: () => {
          if (canvasFailure) throw new Error('canvas read failed');
          afterImageRead?.();
          return { data: new Uint8ClampedArray(64 * 64 * 4).fill(200) };
        },
      };
    }
    async convertToBlob(init?: { type?: string; quality?: number }) {
      afterScreenshotEncode?.();
      encodes.push({ type: init?.type, quality: init?.quality });
      const size = encodedSizes.length > 0 ? encodedSizes.shift()! : 3;
      return new Blob([new Uint8Array(size).fill(1)], { type: init?.type ?? 'image/jpeg' });
    }
  };

  resetVisionRateLimit();
  handleTabUpdated(1, { status: 'loading' });
  tabVisionCache.delete(1);
  return {
    storeWrites,
    sessionWrites,
    sentMessages,
    getCaptureCalls: () => captureCalls,
    getCanvasSizes: () => canvasSizes,
    getEncodes: () => encodes,
    getCaptureCallTimes: () => captureCallTimes,
    setFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
      fetchHandler = handler;
    },
    setUrl(value: string) {
      currentUrl = value;
    },
    setActive(value: boolean) {
      currentActive = value;
    },
    setFocused(value: boolean) {
      currentFocused = value;
    },
    setWindowState(value: string) {
      currentWindowState = value;
    },
    setCaptureFailure(value: boolean) {
      captureFailure = value;
    },
    setDecodeFailure(value: boolean) {
      decodeFailure = value;
    },
    setCanvasFailure(value: boolean) {
      canvasFailure = value;
    },
    setCanvasContextUnavailable(value: boolean) {
      canvasContextUnavailable = value;
    },
    setCaptureApiAvailable(value: boolean) {
      captureApiAvailable = value;
      const tabs = (g.chrome as { tabs: Record<string, unknown> }).tabs;
      if (captureApiAvailable) tabs.captureVisibleTab = captureVisibleTab;
      else delete tabs.captureVisibleTab;
    },
    setAfterImageRead(handler?: () => void) {
      afterImageRead = handler;
    },
    setAfterScreenshotEncode(handler?: () => void) {
      afterScreenshotEncode = handler;
    },
    setWarningVisible(value: boolean) {
      warningVisibleOverride = value;
    },
    setPageIdentity(value: unknown) {
      pageIdentityOverride = value;
    },
    setAfterPageIdentityRead(handler?: (readCount: number, tabId: number) => void) {
      afterPageIdentityRead = handler;
    },
    setAfterTabGet(handler?: (readCount: number, tabId: number) => void) {
      afterTabGet = handler;
    },
    restore() {
      for (const [key, original] of originalGlobals) {
        if (original.existed) g[key] = original.value;
        else delete g[key];
      }
      const cached = tabVisionCache.get(1);
      if (cached) clearTimeout(cached.expiryTimer);
      tabVisionCache.delete(1);
      tabAnalysisStore.forget(1);
      resetVisionRateLimit();
    },
  };
}

test('rgbaToChwTensor matches the Python-generated fixture', () => {
  const tensor = rgbaToChwTensor(fixture.rgba, fixture.width, fixture.height);
  assert.equal(tensor.length, 3 * fixture.width * fixture.height);
  assert.ok(tensor instanceof Float32Array);
  for (let i = 0; i < tensor.length; i++) {
    assert.ok(Math.abs(tensor[i] - fixture.expected[i]) < 1e-3, `mismatch at ${i}`);
  }
});

test('captureVisualTensor captures an active focused http(s) tab once per rate-limit window', async () => {
  const env = setupCaptureEnvironment();
  const first = await captureVisualTensor(1, 7);
  assert.ok(first instanceof Float32Array);
  assert.equal(first.length, 3 * 64 * 64);
  assert.ok(Math.abs(first[0] - 200 / 255) < 1e-6);
  assert.equal(env.getCaptureCalls(), 1);

  // Second evaluation within rate-limit window: captureVisualTensor returns null
  assert.equal(await captureVisualTensor(1, 7), null, 'second call within the interval is rate limited');
  const rateLimited = await captureVisualTensorWithStatus(1, 7);
  assert.equal(rateLimited.status, 'rate_limited');
  assert.equal(rateLimited.reason, 'rate_limited');
  assert.equal(env.getCaptureCalls(), 1);

  const forced = await captureVisualTensor(1, 7, true);
  assert.ok(forced instanceof Float32Array, 'forced capture bypasses interval rate limit');
  assert.equal(env.getCaptureCalls(), 2);

  const realNow = Date.now;
  Date.now = () => realNow() + CAPTURE_INTERVAL_MS + 1;
  try {
    assert.ok((await captureVisualTensor(1, 7)) instanceof Float32Array);
  } finally {
    Date.now = realNow;
  }
});

test('capture eligibility reports inactive tabs, minimized windows and restricted pages', async () => {
  let env = setupCaptureEnvironment({ active: false });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.tensor, null);
    assert.equal(result.reason, 'inactive_tab');
    assert.equal(env.getCaptureCalls(), 0);
  } finally {
    env.restore();
  }

  // An unfocused but visible window (e.g. while the action popup is open)
  // remains capturable.
  env = setupCaptureEnvironment({ focused: false });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.status, 'captured');
    assert.ok(result.tensor instanceof Float32Array);
    assert.equal(env.getCaptureCalls(), 1);
  } finally {
    env.restore();
  }

  env = setupCaptureEnvironment({ focused: false, windowState: 'minimized' });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.tensor, null);
    assert.equal(result.reason, 'unfocused_window');
    assert.equal(env.getCaptureCalls(), 0);
  } finally {
    env.restore();
  }

  env = setupCaptureEnvironment({ url: 'chrome://extensions' });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.tensor, null);
    assert.equal(result.reason, 'restricted_url');
    assert.equal(env.getCaptureCalls(), 0);
  } finally {
    env.restore();
  }
});

test('capture output is discarded when tab focus changes during decoding or encoding', async () => {
  const inferenceEnv = setupCaptureEnvironment();
  try {
    inferenceEnv.setAfterImageRead(() => inferenceEnv.setActive(false));
    const tensor = await captureVisualTensorWithStatus(
      1,
      7,
      true,
      'https://example.com/login'
    );
    assert.equal(tensor.status, 'unavailable');
    assert.equal(tensor.tensor, null);
    assert.equal(tensor.reason, 'inactive_tab');
  } finally {
    inferenceEnv.restore();
  }

  const uploadEnv = setupCaptureEnvironment();
  try {
    uploadEnv.setAfterScreenshotEncode(() => uploadEnv.setWindowState('minimized'));
    const screenshot = await captureScreenshotForUpload(1, 7, 'https://example.com/login');
    assert.equal(screenshot, null);
  } finally {
    uploadEnv.restore();
  }
});

test('upload screenshot keeps the real aspect ratio and only downscales above 2048 px', async () => {
  const large = setupCaptureEnvironment({ bitmapSize: { width: 2560, height: 1440 } });
  try {
    const screenshot = await captureScreenshotForUpload(1, 7, 'https://example.com/login');
    assert.match(String(screenshot), /^data:image\/jpeg;base64,/);
    assert.deepEqual(large.getCanvasSizes(), [{ width: 2048, height: 1152 }]);
    assert.deepEqual(large.getEncodes(), [{ type: 'image/jpeg', quality: 0.85 }]);
  } finally {
    large.restore();
  }

  const small = setupCaptureEnvironment({ bitmapSize: { width: 1280, height: 720 } });
  try {
    assert.ok(await captureScreenshotForUpload(1, 7, 'https://example.com/login'));
    assert.deepEqual(small.getCanvasSizes(), [{ width: 1280, height: 720 }]);
  } finally {
    small.restore();
  }
});

test('upload screenshot re-encodes once at lower quality when oversize, then gives up', async () => {
  const retry = setupCaptureEnvironment({
    bitmapSize: { width: 1280, height: 720 },
    encodedSizes: [UPLOAD_MAX_BYTES + 1, 1000],
  });
  try {
    assert.ok(await captureScreenshotForUpload(1, 7, 'https://example.com/login'));
    assert.deepEqual(retry.getEncodes().map((encode) => encode.quality), [0.85, 0.65]);
  } finally {
    retry.restore();
  }

  const tooBig = setupCaptureEnvironment({
    bitmapSize: { width: 1280, height: 720 },
    encodedSizes: [UPLOAD_MAX_BYTES + 1, UPLOAD_MAX_BYTES + 1],
  });
  try {
    assert.equal(await captureScreenshotForUpload(1, 7, 'https://example.com/login'), null);
    assert.equal(tooBig.getEncodes().length, 2);
  } finally {
    tooBig.restore();
  }
});

test('capture reasons distinguish missing APIs, changed pages, capture failures and decode failures', async () => {
  const missingApiEnv = setupCaptureEnvironment();
  try {
    missingApiEnv.setCaptureApiAvailable(false);
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.reason, 'missing_api');
  } finally {
    missingApiEnv.restore();
  }

  const changedPageEnv = setupCaptureEnvironment();
  try {
    changedPageEnv.setUrl('https://example.com/changed');
    const result = await captureVisualTensorWithStatus(1, 7, false, 'https://example.com/login');
    assert.equal(result.reason, 'page_changed');
    assert.equal(changedPageEnv.getCaptureCalls(), 0);
  } finally {
    changedPageEnv.restore();
  }

  const captureFailureEnv = setupCaptureEnvironment({ captureFailure: true });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.reason, 'capture_api_failure');
  } finally {
    captureFailureEnv.restore();
  }

  const decodeFailureEnv = setupCaptureEnvironment({ decodeFailure: true });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.reason, 'decode_canvas_failure');
  } finally {
    decodeFailureEnv.restore();
  }

  const canvasFailureEnv = setupCaptureEnvironment({ canvasContextUnavailable: true });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.reason, 'decode_canvas_failure');
  } finally {
    canvasFailureEnv.restore();
  }

  const drawFailureEnv = setupCaptureEnvironment({ canvasFailure: true });
  try {
    const result = await captureVisualTensorWithStatus(1, 7);
    assert.equal(result.reason, 'decode_canvas_failure');
  } finally {
    drawFailureEnv.restore();
  }
});

test('capture discards frames when the URL changes during decoding', async () => {
  const env = setupCaptureEnvironment();
  try {
    env.setAfterImageRead(() => env.setUrl('https://example.com/changed'));
    const result = await captureVisualTensorWithStatus(1, 7, true, 'https://example.com/login');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.tensor, null);
    assert.equal(result.reason, 'page_changed');
  } finally {
    env.restore();
  }
});

function payload(hasCredentialField: boolean): InteractionTelemetryPayload {
  return {
    telemetryId: '44444444-4444-4444-4444-444444444444',
    url: 'https://example.com/login',
    domain: 'example.com',
    pageTitle: 'Login',
    sessionDurationMs: 1000,
    pointerSeries: Array.from({ length: 16 }, (_, index) => ({
      x: 0.1 + index * 0.01,
      y: 0.2 + index * 0.005,
      dx: 10,
      dy: 5,
      velocity: 0.3,
      acceleration: 0,
      angle: 0.46,
      timestamp: index * 10,
      eventType: 'move' as const,
    })),
    keystrokes: [],
    domEvents: [],
    hasCredentialField,
    clientTimestamp: new Date().toISOString(),
  };
}

function engineWithFakeSession(scoreFor: (visualSum: number) => number) {
  const engine = new OnDeviceStudentEngine();
  const feedsSeen: Array<Record<string, { dims: number[]; data: Float32Array }>> = [];
  const internals = engine as unknown as { session: unknown; isLoaded: boolean };
  internals.session = {
    inputNames: ['trajectory', 'visual'],
    outputNames: ['risk_score'],
    run: async (feeds: Record<string, ort.Tensor>) => {
      // Feed tensors are disposed once the run completes; snapshot their
      // contents inside the run while they are still valid.
      const snapshot: Record<string, { dims: number[]; data: Float32Array }> = {};
      for (const [name, tensor] of Object.entries(feeds)) {
        snapshot[name] = { dims: [...tensor.dims], data: new Float32Array(tensor.data as Float32Array) };
      }
      feedsSeen.push(snapshot);
      const sum = snapshot.visual.data.reduce((a, b) => a + b, 0);
      return { risk_score: { data: new Float32Array([scoreFor(sum)]) } };
    },
  };
  internals.isLoaded = true;
  return { engine, feedsSeen };
}

test('legacy engine uses the captured visual input only within the fused model prediction', async () => {
  const { engine, feedsSeen } = engineWithFakeSession((sum) => (sum > 0 ? 0.6 : 0.1));
  const frame = new Float32Array(3 * 64 * 64).fill(0.5);

  const { result, breakdown } = await engine.predictDetailed(payload(true), frame);

  assert.equal(feedsSeen.length, 1);
  assert.equal(feedsSeen[0].visual.dims.join('x'), '1x3x64x64');
  assert.ok((feedsSeen[0].visual.data as Float32Array)[0] === 0.5);
  assert.equal(result.clientRiskScore, 0.6);
  assert.ok(Math.abs((breakdown.fused.modelScore ?? 0) - 0.6) < 1e-6);
  assert.equal(breakdown.vision.score, null);
  assert.equal(breakdown.vision.status, 'ok');
  assert.equal(breakdown.vision.detail, 'Visual input included in fused model evaluation');
  assert.equal(breakdown.interaction.score, null);
});

test('visual availability does not claim a verified brand or layout match', async () => {
  const { engine } = engineWithFakeSession((sum) => (sum > 0 ? 0.12 : 0.1));
  const { breakdown } = await engine.predictDetailed(payload(true), new Float32Array(3 * 64 * 64).fill(0.5));
  assert.equal(breakdown.vision.status, 'ok');
  assert.equal(breakdown.vision.detail, 'Visual input included in fused model evaluation');
});

test('legacy engine does not infer when its visual input is unavailable', async () => {
  const { engine, feedsSeen } = engineWithFakeSession(() => 0.2);

  const noField = await engine.predictDetailed(payload(false), null);
  assert.equal(noField.breakdown.vision.status, 'skipped');
  assert.equal(noField.breakdown.vision.detail, 'Visual capture failed; page analysis continued');

  const hidden = await engine.predictDetailed(payload(true), null);
  assert.equal(hidden.breakdown.vision.status, 'skipped');
  assert.equal(feedsSeen.length, 0);
});

test('vision explainability identifies each capture failure reason', async () => {
  const reasons: Array<[VisionUnavailableReason, VisionCaptureState, string]> = [
    ['missing_api', 'restricted', 'Visual capture API is unavailable; page analysis continued'],
    ['inactive_tab', 'pending', 'Visual capture is pending until this tab is active'],
    ['unfocused_window', 'pending', 'Visual capture is pending until this window is restored'],
    ['restricted_url', 'restricted', 'Visual capture is not permitted for this page; page analysis continued'],
    ['page_changed', 'pending', 'The page changed during capture; a fresh page scan is pending'],
    ['model_changed', 'pending', 'The active model changed during visual capture; retrying visual capture 1 of 2'],
    ['capture_api_failure', 'pending', 'Visual capture API failed; retrying visual capture 1 of 2'],
    ['decode_canvas_failure', 'pending', 'Visual frame decoding or canvas processing failed; retrying visual capture 1 of 2'],
    ['rate_limited', 'pending', 'Visual capture was rate limited; no fresh frame is available; retrying visual capture 1 of 2'],
    [
      'warning_visible_no_fresh_frame',
      'suppressed',
      'Visual capture suppressed while the warning is visible; no fresh pre-warning frame is available',
    ],
  ];
  for (const [reason, state, detail] of reasons) {
    const { engine } = engineWithFakeSession(() => 0.2);
    const { breakdown } = await engine.predictDetailed(payload(true), null, {
      visionUnavailableReason: reason,
    });
    assert.equal(breakdown.vision.detail, detail);
    assert.equal(breakdown.vision.explainability.captureReason, reason);
    assert.equal(breakdown.vision.explainability.captureState, state);
  }
});

test('two complete DOM traps still block when visual capture fails', async () => {
  const { engine } = engineWithFakeSession(() => 0.2);
  const suspicious = payload(true);
  const coveredControlTypes = ['password', 'submit'] as const;
  suspicious.domEvents = coveredControlTypes.map((coveredControlType, index) => ({
    eventType: 'click' as const,
    targetBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: `control-${index}`,
    timestamp: index + 1,
    evidenceSource: 'topology_scan' as const,
    evidenceId: `control-${coveredControlType}`,
    isHitTestIntercepting: true,
    coveredControlType,
    credentialFrameEvidence: 'none' as const,
  }));

  const { result, breakdown } = await engine.predictDetailed(suspicious, null, {
    visionUnavailableReason: 'capture_api_failure',
    visionRecoveryAttempt: 0,
  });
  assert.equal(result.routeAction, 'BLOCK');
  assert.ok(result.clientRiskScore > 0.85);
  assert.equal(breakdown.fused.modelScore, null);
  assert.equal(breakdown.vision.explainability.captureState, 'pending');
});

test('service-worker evidence blocks two complete traps while visual capture fails', async () => {
  const env = setupCaptureEnvironment({ captureFailure: true });
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const suspicious = payload(true);
  suspicious.domEvents = (['password', 'submit'] as const).map((coveredControlType, index) => ({
    eventType: 'click' as const,
    targetBoundingBox: { x: 100, y: 100, width: 200, height: 40 },
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: `control-${index}`,
    timestamp: index + 1,
    evidenceSource: 'topology_scan' as const,
    evidenceId: `capture-failure-control-${coveredControlType}`,
    isHitTestIntercepting: true,
    coveredControlType,
    credentialFrameEvidence: 'none' as const,
  }));
  try {
    await handleTelemetryEvaluation(suspicious, 1);
    const snapshot = tabAnalysisStore.get(1, suspicious.url);
    assert.ok(snapshot);
    assert.equal(snapshot.analysis.action, 'BLOCK');
    assert.ok(snapshot.analysis.riskScore > 0.85);
    assert.equal(snapshot.analysis.signals.fused.modelScore, null);
    assert.equal(snapshot.analysis.signals.vision.explainability.captureState, 'pending');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureReason, 'capture_api_failure');
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

// Page without password field: vision still runs and correlates
test('visual coverage is independent of password fields and legacy DOM flags', async () => {
  const { engine } = engineWithFakeSession((sum) => (sum > 0 ? 0.45 : 0.1));
  const frame = new Float32Array(3 * 64 * 64).fill(0.5);

  const { breakdown } = await engine.predictDetailed(payload(false), frame);
  assert.equal(breakdown.vision.status, 'ok');
  assert.equal(breakdown.vision.detail, 'Visual input included in fused model evaluation');

  // Page with hidden overlay trap: correlates overlay with visual layout
  const payloadWithTrap = payload(false);
  payloadWithTrap.domEvents = [{
    eventType: 'click',
    targetBoundingBox: { x: 0, y: 0, width: 0, height: 0 },
    timestamp: Date.now(),
    elementSelector: 'div@e1',
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    evidenceSource: 'legacy',
    evidenceId: 'old-overlay',
    isHitTestIntercepting: false,
    coveredControlType: 'none',
    credentialFrameEvidence: 'none',
  }];
  const { breakdown: trapBreakdown } = await engine.predictDetailed(payloadWithTrap, frame);
  assert.equal(trapBreakdown.vision.status, 'ok');
  assert.equal(trapBreakdown.page.score, 0.05);
});

function containsImageOrTensor(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('data:image');
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > 1000) return true;
    return value.some(containsImageOrTensor);
  }
  if (value && typeof value === 'object') return Object.values(value).some(containsImageOrTensor);
  return false;
}

test('privacy: captured frames never reach session state or inspection history', async () => {
  const env = setupCaptureEnvironment();
  const inspections: unknown[] = [];
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async (record) => {
    inspections.push(record);
  };

  try {
    await handleTelemetryEvaluation({
      ...payload(true),
      viewportCapture: {
        width: 64,
        height: 64,
        mimeType: 'image/jpeg',
        base64Data: 'data:image/jpeg;base64,PRIVATE_CAPTURE',
        scrollOffset: { x: 0, y: 0 },
        capturedAt: 1,
      },
    }, 1);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
  }

  assert.equal(env.getCaptureCalls(), 1, 'a frame was captured for the credential page');
  assert.ok(env.sessionWrites.length > 0);
  for (const write of env.sessionWrites) {
    assert.equal(containsImageOrTensor(write), false, 'storage write must not contain images or tensors');
  }
  assert.equal(inspections.length, 1);
  assert.equal(containsImageOrTensor(inspections[0]), false);
  const snapshot = Object.values(env.sessionWrites[0] as Record<string, unknown>)[0] as {
    payload: { viewportCapture?: unknown };
    analysis: { signals: { vision: { status: string } } };
  };
  assert.equal(snapshot.payload.viewportCapture, undefined);
  assert.equal(snapshot.analysis.signals.vision.status, 'ok');
});

test('vision cache reuses the same recent frame for the same page snapshot', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  try {
    await handleTelemetryEvaluation(payload(true), 1);
    assert.equal(env.getCaptureCalls(), 1);
    const first = Object.values(env.sessionWrites[0] as Record<string, unknown>)[0] as {
      analysis: { signals: { vision: { status: string; detail: string }; fused: { coverage: { visualAvailable: boolean } } } };
    };
    assert.equal(first.analysis.signals.vision.status, 'ok');
    assert.equal(first.analysis.signals.vision.detail, 'Visual frame captured; model inference unavailable');
    assert.equal(first.analysis.signals.fused.coverage.visualAvailable, true);

    await handleTelemetryEvaluation(payload(true), 1);
    assert.equal(env.getCaptureCalls(), 1, 'rate limited - no second raw capture');
    const second = Object.values(env.sessionWrites[env.sessionWrites.length - 1] as Record<string, unknown>)[0] as {
      analysis: { signals: { vision: { status: string; detail: string }; fused: { coverage: { visualAvailable: boolean } } } };
    };
    assert.equal(second.analysis.signals.vision.status, 'ok');
    assert.equal(second.analysis.signals.vision.detail, 'Visual frame captured; model inference unavailable');
    assert.equal(second.analysis.signals.fused.coverage.visualAvailable, true);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('a model change during capture discards the old-hash frame and reports retryable recovery', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const engineState = serviceWorkerEngine as unknown as {
    activeMetadata: { sha256: string } | null;
  };
  const originalMetadata = engineState.activeMetadata;
  env.setAfterImageRead(() => {
    engineState.activeMetadata = { sha256: 'b'.repeat(64) };
  });
  try {
    await handleTelemetryEvaluation(payload(true), 1);
    const snapshot = tabAnalysisStore.get(1);
    assert.ok(snapshot);
    assert.equal(env.getCaptureCalls(), 1);
    assert.equal(tabVisionCache.has(1), false);
    assert.equal(snapshot.analysis.signals.fused.coverage.visualAvailable, false);
    assert.equal(snapshot.analysis.signals.vision.explainability.captureState, 'pending');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureReason, 'model_changed');

    env.setAfterImageRead(undefined);
    await handleTelemetryEvaluation(payload(true), 1, true);
    const recovered = tabAnalysisStore.get(1, payload(true).url);
    assert.ok(recovered);
    assert.equal(env.getCaptureCalls(), 2);
    assert.equal(tabVisionCache.get(1)?.modelHash, 'b'.repeat(64));
    assert.equal(recovered.analysis.signals.fused.coverage.visualAvailable, true);
    assert.equal(recovered.analysis.signals.vision.explainability.captureState, 'captured');
  } finally {
    engineState.activeMetadata = originalMetadata;
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('model invalidation during the final page-identity await drops the local old-hash tensor', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const engineState = serviceWorkerEngine as unknown as {
    activeMetadata: { sha256: string } | null;
  };
  const originalMetadata = engineState.activeMetadata;
  engineState.activeMetadata = { sha256: 'a'.repeat(64) };
  const currentPayload = payload(true);
  const envelope: PageEvaluationEnvelope = {
    pageSessionId: 'model-change-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: currentPayload.url,
    warningVisible: false,
    topologyScanComplete: true,
  };
  env.setPageIdentity({ ...envelope });
  let invalidated = false;
  env.setAfterPageIdentityRead((readCount, tabId) => {
    if (readCount !== 4 || invalidated) return;
    invalidated = true;
    engineState.activeMetadata = { sha256: 'b'.repeat(64) };
    const cached = tabVisionCache.get(tabId);
    if (cached) clearTimeout(cached.expiryTimer);
    tabVisionCache.delete(tabId);
  });
  try {
    await handleTelemetryEvaluation(currentPayload, 1, true, envelope);
    const snapshot = tabAnalysisStore.get(1, currentPayload.url);
    assert.ok(snapshot);
    assert.equal(invalidated, true);
    assert.equal(env.getCaptureCalls(), 1);
    assert.equal(tabVisionCache.has(1), false);
    assert.equal(snapshot.analysis.signals.fused.coverage.visualAvailable, false);
    assert.equal(snapshot.analysis.signals.vision.explainability.captureState, 'pending');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureReason, 'model_changed');
  } finally {
    engineState.activeMetadata = originalMetadata;
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('vision cache is not reused after the exact page URL changes', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  try {
    await handleTelemetryEvaluation(payload(true), 1);
    assert.equal(tabVisionCache.has(1), true);
    const nextUrl = 'https://example.com/next?Case=Sensitive';
    env.setUrl(nextUrl);
    const nextPayload = { ...payload(true), url: nextUrl };
    await handleTelemetryEvaluation(nextPayload, 1);
    assert.equal(env.getCaptureCalls(), 1);
    assert.equal(tabVisionCache.has(1), false);
    const latest = Object.values(env.sessionWrites.at(-1) as Record<string, unknown>)[0] as {
      analysis: { signals: { fused: { coverage: { visualAvailable: boolean } } } };
    };
    assert.equal(latest.analysis.signals.fused.coverage.visualAvailable, false);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('a warning-visible evaluation reports suppression without capturing warning pixels', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const currentPayload = payload(true);
  const envelope: PageEvaluationEnvelope = {
    pageSessionId: 'warning-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: currentPayload.url,
    warningVisible: true,
    topologyScanComplete: true,
  };
  env.setPageIdentity({
    pageSessionId: envelope.pageSessionId,
    navigationGeneration: envelope.navigationGeneration,
    evaluationGeneration: envelope.evaluationGeneration,
    url: envelope.url,
    warningVisible: true,
    topologyScanComplete: true,
  });
  try {
    await handleTelemetryEvaluation(currentPayload, 1, false, envelope);
    assert.equal(env.getCaptureCalls(), 0);
    const snapshot = tabAnalysisStore.get(1, currentPayload.url);
    assert.ok(snapshot);
    const signals = snapshot.analysis.signals as {
      vision: { detail: string; explainability: { captureReason: VisionUnavailableReason | null } };
    };
    assert.equal(
      signals.vision.detail,
      'Visual capture suppressed while the warning is visible; no fresh pre-warning frame is available'
    );
    assert.equal(signals.vision.explainability.captureReason, 'warning_visible_no_fresh_frame');
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('rate-limited evaluation without a fresh page frame reports the missing frame', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  try {
    const firstCapture = await captureVisualTensorWithStatus(1, 7, true, payload(true).url);
    assert.equal(firstCapture.status, 'captured');
    await handleTelemetryEvaluation(payload(true), 1);
    const snapshot = tabAnalysisStore.get(1, payload(true).url);
    assert.ok(snapshot);
    const signals = snapshot.analysis.signals as {
      vision: { detail: string; explainability: { captureReason: VisionUnavailableReason | null } };
    };
    assert.equal(
      signals.vision.detail,
      'Visual capture was rate limited; no fresh frame is available; retrying visual capture 1 of 2'
    );
    assert.equal(signals.vision.explainability.captureReason, 'rate_limited');
    assert.equal(env.getCaptureCalls(), 1);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('fused explainability reports modality coverage without per-modality truth claims', async () => {
  const { engine } = engineWithFakeSession((sum) => (sum > 0 ? 0.12 : 0.1));
  const frame = new Float32Array(3 * 64 * 64).fill(0.5);
  const p = payload(true);

  const { breakdown } = await engine.predictDetailed(p, frame);
  assert.equal(breakdown.fused.modelStatus, 'available');
  assert.deepEqual(breakdown.fused.coverage, {
    trajectoryAvailable: true,
    validPointCount: 16,
    durationMs: 150,
    visualAvailable: true,
    pageContextAvailable: true,
    topologyScanComplete: true,
  });
  assert.equal(breakdown.interaction.score, null);
  assert.equal(breakdown.vision.score, null);
});

test('manual escalation is tab-bound and sends nothing before gateway protocol support', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  const originalFetch = globalThis.fetch;
  const inspections: unknown[] = [];
  let escalationRequests = 0;
  sqliteStorage.recordInspection = async (record) => {
    inspections.push(record);
  };
  try {
    await handleTelemetryEvaluation(payload(true), 1);
    const snapshot = tabAnalysisStore.get(1);
    assert.ok(snapshot);
    const reference = {
      pageSessionId: snapshot.pageSessionId,
      navigationGeneration: snapshot.navigationGeneration,
      evaluationGeneration: snapshot.evaluationGeneration,
      telemetryId: snapshot.telemetryId,
      url: snapshot.url,
      warningVisible: snapshot.warningVisible,
      topologyScanComplete: snapshot.topologyScanComplete,
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/escalate')) escalationRequests++;
      return { blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response;
    }) as typeof fetch;

    await assert.rejects(
      handleManualEscalation(1, true, reference),
      /CLOUD_UPGRADE_REQUIRED/,
    );
    await assert.rejects(
      handleManualEscalation(1, false, reference),
      /CLOUD_UPGRADE_REQUIRED/,
    );
    await assert.rejects(
      handleManualEscalation(2, true, reference),
      /No local interaction telemetry is available for this tab/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.recordInspection = originalRecord;
  }
  assert.equal(escalationRequests, 0);
  assert.equal(env.getCaptureCalls(), 1, 'the requested screenshot was not captured');
  assert.equal(inspections.length, 1);
  for (const write of env.sessionWrites) {
    assert.equal(containsImageOrTensor(write), false, 'session state must not contain images or tensors');
  }
});

test('manual escalation sends the exact snapshot with consented screenshots and drops stale responses', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const compatibleHealth = {
    capabilities: {
      telemetryEvidenceVersion: 2,
      modelInputContracts: ['student-v1', 'student-v2'],
      manualEscalation: true,
    },
  };
  let nextAction = 'ALLOW';
  const verdict = (telemetryId: string, actionOverride = 'ALLOW') => ({
    analysisId: '11111111-1111-4111-8111-111111111111',
    telemetryId,
    isPhishing: actionOverride === 'BLOCK',
    targetBrand: null,
    confidence: actionOverride === 'BLOCK' ? 0.95 : 0.2,
    actionOverride,
    explanationReasons: [],
    teacherModelVersion: 'cloud-evidence-v2',
    evaluatedAt: new Date().toISOString(),
  });
  sqliteStorage.recordInspection = async () => {};
  env.setFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => compatibleHealth } as unknown as Response;
    }
    if (url.endsWith('/v1/escalate')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        body,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return {
        ok: true,
        status: 200,
        json: async () => verdict(String(body.telemetryId), nextAction),
      } as unknown as Response;
    }
    return { blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response;
  });

  try {
    await handleTelemetryEvaluation(payload(true), 1);
    const snapshot = tabAnalysisStore.get(1);
    assert.ok(snapshot);
    const reference = {
      pageSessionId: snapshot.pageSessionId,
      navigationGeneration: snapshot.navigationGeneration,
      evaluationGeneration: snapshot.evaluationGeneration,
      telemetryId: snapshot.telemetryId,
      url: snapshot.url,
      warningVisible: snapshot.warningVisible,
      topologyScanComplete: snapshot.topologyScanComplete,
    };
    const capturesBeforeManual = env.getCaptureCalls();

    await handleManualEscalation(1, false, reference);
    assert.equal(requests[0].body.screenshotBase64, undefined);
    assert.equal(requests[0].body.telemetryId, snapshot.telemetryId);
    assert.equal(requests[0].body.hasCredentialField, snapshot.payload.hasCredentialField);
    assert.equal(requests[0].authorization, 'Bearer test_client_key');
    assert.equal(env.getCaptureCalls(), capturesBeforeManual);

    await handleManualEscalation(1, true, reference);
    assert.match(String(requests[1].body.screenshotBase64), /^data:image\/jpeg;base64,/);
    assert.equal(env.getCaptureCalls(), capturesBeforeManual + 1);

    env.setWarningVisible(true);
    await handleManualEscalation(1, true, reference);
    assert.equal(requests[2].body.screenshotBase64, null);
    assert.equal(env.getCaptureCalls(), capturesBeforeManual + 1);
    env.setWarningVisible(false);

    nextAction = 'BLOCK';
    // 1. Manually prompt cloud escalation
    const previousWarningCount = env.sentMessages.filter(({ message }) =>
      message.type === 'SHOW_PHISHING_BANNER'
    ).length;
    await handleManualEscalation(1, false, reference);
    // 2. Assert cloud verdict is cached in storage for popup display
    assert.equal(tabAnalysisStore.get(1)?.cloudVerdict?.actionOverride, 'BLOCK');
    // 3. Assert on-screen warning banner was dispatched because cloud verdict gave BLOCK override
    const warning = env.sentMessages.find(({ message }) => message.type === 'SHOW_PHISHING_BANNER')?.message;
    assert.ok(warning);
    assert.equal(warning.pageSessionId, snapshot.pageSessionId);
    assert.equal(warning.evaluationGeneration, snapshot.evaluationGeneration);
    assert.equal(
      env.sentMessages.filter(({ message }) => message.type === 'SHOW_PHISHING_BANNER').length,
      previousWarningCount + 1,
    );

    env.setFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => compatibleHealth } as unknown as Response;
      }
      if (url.endsWith('/v1/escalate')) {
        tabAnalysisStore.invalidate(1);
        env.setUrl('https://example.com/reloaded');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          json: async () => verdict(String(body.telemetryId), 'BLOCK'),
        } as unknown as Response;
      }
      return { blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response;
    });
    const warningCountBeforeStale = env.sentMessages.filter(({ message }) =>
      message.type === 'SHOW_PHISHING_BANNER'
    ).length;
    await assert.rejects(handleManualEscalation(1, false, reference), /PAGE_SNAPSHOT_STALE/);
    assert.equal(
      env.sentMessages.filter(({ message }) => message.type === 'SHOW_PHISHING_BANNER').length,
      warningCountBeforeStale,
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('back-to-back captureVisibleTab calls are spaced by the capture quota gate', async () => {
  const env = setupCaptureEnvironment();
  try {
    const first = await captureVisualTensorWithStatus(1, 7, true);
    const second = await captureVisualTensorWithStatus(1, 7, true);
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'captured');
    const times = env.getCaptureCallTimes();
    assert.equal(times.length, 2);
    // Small tolerance for timer resolution; the gate targets >= 550 ms.
    assert.ok(
      times[1] - times[0] >= CAPTURE_MIN_SPACING_MS - 10,
      `second capture started ${times[1] - times[0]} ms after the first`
    );
  } finally {
    env.restore();
  }
});

test('a transient capture failure reuses a recent same-page frame instead of reporting PENDING', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  try {
    await handleTelemetryEvaluation(payload(true), 1);
    assert.equal(env.getCaptureCalls(), 1);
    assert.equal(tabVisionCache.has(1), true);

    env.setCaptureFailure(true);
    await handleTelemetryEvaluation(payload(true), 1, true);
    const snapshot = tabAnalysisStore.get(1, payload(true).url);
    assert.ok(snapshot);
    assert.equal(env.getCaptureCalls(), 2, 'the forced evaluation still attempted a capture');
    assert.equal(snapshot.analysis.signals.fused.coverage.visualAvailable, true);
    assert.equal(snapshot.analysis.signals.vision.status, 'ok');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureState, 'captured');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureReason, null);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('a page change during capture does not fall back to the cached frame', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const first = payload(true);
  try {
    await handleTelemetryEvaluation(first, 1);
    assert.equal(env.getCaptureCalls(), 1);
    assert.equal(tabVisionCache.has(1), true);

    // Flip the tab URL after the second evaluation's stale-check get but
    // before the capture's eligibility get, then restore it so the
    // post-evaluation checks still pass.
    let evalTabGets = 0;
    env.setAfterTabGet(() => {
      evalTabGets++;
      if (evalTabGets === 4) env.setUrl('https://example.com/moved');
      if (evalTabGets === 5) env.setUrl(first.url);
    });
    await handleTelemetryEvaluation(first, 1, true);
    const snapshot = tabAnalysisStore.get(1, first.url);
    assert.ok(snapshot);
    assert.equal(snapshot.analysis.signals.fused.coverage.visualAvailable, false);
    assert.equal(snapshot.analysis.signals.vision.explainability.captureState, 'pending');
    assert.equal(snapshot.analysis.signals.vision.explainability.captureReason, 'page_changed');
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('a topology coverage flip during evaluation is not stale and keeps the envelope snapshot', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const currentPayload = payload(true);
  const envelope: PageEvaluationEnvelope = {
    pageSessionId: 'topology-flip-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: currentPayload.url,
    warningVisible: false,
    topologyScanComplete: true,
  };
  // The live collector restarted its scan cycle while the evaluation ran;
  // coverage alone changed, so the evaluation must not be dropped.
  env.setPageIdentity({ ...envelope, topologyScanComplete: false });
  try {
    const result = await handleTelemetryEvaluation(currentPayload, 1, true, envelope);
    assert.notEqual((result as { stale?: boolean }).stale, true);
    const snapshot = tabAnalysisStore.get(1, currentPayload.url);
    assert.ok(snapshot);
    assert.equal(snapshot.topologyScanComplete, true);
    assert.equal(snapshot.analysis.topologyScanComplete, true);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('a warning visibility flip during evaluation is still stale', async () => {
  const env = setupCaptureEnvironment();
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const currentPayload = payload(true);
  const envelope: PageEvaluationEnvelope = {
    pageSessionId: 'warning-flip-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: currentPayload.url,
    warningVisible: false,
    topologyScanComplete: true,
  };
  env.setPageIdentity({ ...envelope, warningVisible: true });
  try {
    const result = await handleTelemetryEvaluation(currentPayload, 1, true, envelope);
    assert.equal((result as { stale?: boolean }).stale, true);
    assert.equal(tabAnalysisStore.get(1, currentPayload.url), null);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
    env.restore();
  }
});

test('handleTabUpdated notifies the live collector on same-document URL changes', () => {
  const env = setupCaptureEnvironment();
  try {
    // Same-document navigations report url and loading status together; the
    // url branch must win so the live session is nudged, not retired.
    env.sentMessages.length = 0;
    handleTabUpdated(1, { url: 'https://example.com/route-b', status: 'loading' });
    let notices = env.sentMessages.filter((entry) => entry.message.type === 'PAGE_URL_CHANGED');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].tabId, 1);
    assert.equal(notices[0].message.url, 'https://example.com/route-b');

    env.sentMessages.length = 0;
    handleTabUpdated(1, { url: 'https://example.com/route-c', status: 'complete' });
    notices = env.sentMessages.filter((entry) => entry.message.type === 'PAGE_URL_CHANGED');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].message.url, 'https://example.com/route-c');

    // A bare status change carries no URL nudge.
    env.sentMessages.length = 0;
    handleTabUpdated(1, { status: 'complete' });
    assert.equal(env.sentMessages.filter((entry) => entry.message.type === 'PAGE_URL_CHANGED').length, 0);
  } finally {
    env.restore();
  }
});

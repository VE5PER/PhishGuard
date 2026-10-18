import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionTelemetryPayloadSchema } from '@phishguard/types';
import { TelemetryCollector } from '../src/content/telemetry-collector.ts';
import type { VisionCaptureState, VisionUnavailableReason } from '../src/background/types.ts';

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  toJSON(): object;
}

interface FakeElement {
  tagName: string;
  type?: string;
  src?: string;
  id: string;
  className: string;
  nodeType: number;
  parentElement: FakeElement | null;
  isConnected: boolean;
  rect: { x: number; y: number; width: number; height: number };
  children: FakeElement[];
  contains(element: FakeElement): boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeElement | null;
  getBoundingClientRect(): FakeRect;
  remove(): void;
}

interface FakeStyle extends CSSStyleDeclaration {
  opacity: string;
  visibility: string;
  display: string;
  position: string;
  pointerEvents: string;
}

function evaluationResponse(
  message: Record<string, unknown>,
  captureState: VisionCaptureState,
  captureReason: VisionUnavailableReason | null
) {
  const payload = message.payload as Record<string, unknown>;
  return {
    success: true,
    result: {
      telemetryId: payload.telemetryId,
      pageSessionId: message.pageSessionId,
      navigationGeneration: message.navigationGeneration,
      evaluationGeneration: message.evaluationGeneration,
      url: message.url,
      warningVisible: message.warningVisible,
      topologyScanComplete: message.topologyScanComplete,
      signals: {
        vision: {
          status: captureState === 'captured' ? 'ok' : 'skipped',
          detail: captureState === 'captured' ? 'Visual frame captured' : 'Visual capture pending',
          explainability: { available: captureState === 'captured', captureReason, captureState },
        },
      },
    },
  };
}

function makeElement(
  tagName: string,
  rect: FakeElement['rect'],
  overrides: Partial<FakeElement> = {}
): FakeElement {
  const element = {
    tagName: tagName.toUpperCase(),
    type: '',
    src: '',
    id: '',
    className: '',
    nodeType: 1,
    parentElement: null,
    isConnected: true,
    children: [],
    rect,
    getAttribute(name: string) {
      if (name === 'src') return this.src || null;
      if (name === 'type') return this.type || null;
      if (name === 'role' || name === 'tabindex') return null;
      return null;
    },
    closest() {
      return null;
    },
    contains(other: FakeElement) {
      return this.children.includes(other) ||
        this.children.some((child) => child.contains(other));
    },
    getBoundingClientRect() {
      const { x, y, width, height } = this.rect;
      return {
        x,
        y,
        width,
        height,
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({}),
      };
    },
    remove() {
      this.isConnected = false;
    },
    ...overrides,
  } as FakeElement;
  return element;
}

function setupCollectorEnvironment() {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  for (const key of [
    'window',
    'document',
    'chrome',
    'Node',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
  ]) {
    original[key] = globals[key];
  }
  const controls = [
    makeElement('input', { x: 100, y: 100, width: 200, height: 40 }, { type: 'password' }),
    makeElement('button', { x: 100, y: 200, width: 200, height: 40 }, { type: 'submit' }),
  ];
  const overlays = [
    makeElement('div', { x: 100, y: 100, width: 200, height: 40 }, { id: 'auth-overlay-private-name' }),
    makeElement('div', { x: 100, y: 200, width: 200, height: 40 }),
  ];
  const iframe = makeElement('iframe', { x: 400, y: 100, width: 300, height: 200 }, {
    src: 'https://foreign.example/frame',
  });
  const nativeControl = makeElement('input', { x: 100, y: 100, width: 20, height: 20 }, { type: 'checkbox' });
  const styles = new Map<FakeElement, FakeStyle>();
  let scanControls = controls;
  for (const control of controls) {
    styles.set(control, {
      opacity: '1',
      visibility: 'visible',
      display: 'block',
      position: 'static',
      pointerEvents: 'auto',
    } as FakeStyle);
  }
  for (const overlay of overlays) {
    styles.set(overlay, {
      opacity: '0',
      visibility: 'visible',
      display: 'block',
      position: 'fixed',
      pointerEvents: 'auto',
    } as FakeStyle);
  }
  styles.set(iframe, {
    opacity: '1',
    visibility: 'visible',
    display: 'block',
    position: 'static',
    pointerEvents: 'auto',
  } as FakeStyle);
  styles.set(nativeControl, {
    opacity: '0',
    visibility: 'visible',
    display: 'block',
    position: 'absolute',
    pointerEvents: 'auto',
  } as FakeStyle);

  const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const navigationListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const runtimeListeners: Array<(message: Record<string, unknown>, sender: object, respond: (value?: unknown) => void) => unknown> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const animationFrames = new Map<number, () => void>();
  const fakeTimers = new Map<number, { delay: number; callback: () => void }>();
  let nextFrameId = 1;
  let nextTimerId = 1;
  let fakeTimersEnabled = false;
  let trapsEnabled = true;
  let nativePatternEnabled = false;
  let nowOverride: number | null = null;
  let documentVisibilityState: DocumentVisibilityState = 'visible';
  let querySelectorAllCalls = 0;
  let responseForMessage: (message: Record<string, unknown>) => unknown = () => ({ success: true });
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const scheduleTimer = (callback: () => void, delay = 0): number => {
    if (!fakeTimersEnabled) return realSetTimeout(callback, delay) as unknown as number;
    const id = nextTimerId++;
    fakeTimers.set(id, { delay, callback });
    return id;
  };
  const clearTimer = (id: number | ReturnType<typeof setTimeout>): void => {
    if (fakeTimersEnabled && typeof id === 'number') {
      fakeTimers.delete(id);
      return;
    }
    realClearTimeout(id as ReturnType<typeof setTimeout>);
  };
  const performanceNow = performance.now.bind(performance);
  const childOverlays = new Map<number, FakeElement>();
  const window = {
    location: {
      href: 'https://collector.example/login',
      hostname: 'collector.example',
      origin: 'https://collector.example',
    },
    innerWidth: 1280,
    innerHeight: 720,
    navigation: {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        const listeners = navigationListeners.get(type) ?? [];
        listeners.push(listener);
        navigationListeners.set(type, listeners);
      },
    },
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout: scheduleTimer,
    clearTimeout: clearTimer,
    getComputedStyle: (element: Element) => styles.get(element as unknown as FakeElement) ?? {
      opacity: '1',
      visibility: 'visible',
      display: 'block',
      position: 'static',
      pointerEvents: 'auto',
    },
  };
  const document = {
    readyState: 'loading',
    get visibilityState() {
      return documentVisibilityState;
    },
    title: 'Collector test',
    documentElement: {},
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    querySelector: (selector: string) =>
      selector === 'input[type="password"]' ? controls[0] : null,
    querySelectorAll: (selector: string) => {
      querySelectorAllCalls++;
      if (selector === 'iframe') return [iframe];
      return scanControls;
    },
    elementsFromPoint: (x: number, y: number) => {
      const controlIndex = scanControls.findIndex(({ rect }) =>
        x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
      );
      if (controlIndex < 0) return [];
      const control = scanControls[controlIndex];
      if (nativePatternEnabled) return [nativeControl, control];
      const childOverlay = childOverlays.get(controlIndex);
      if (childOverlay) return [childOverlay, overlays[controlIndex], control];
      if (trapsEnabled) return [overlays[controlIndex === 0 ? 0 : 1], control];
      return [control];
    },
    getElementById: () => null,
  };
  const chrome = {
    runtime: {
      id: 'collector-test-runtime',
      lastError: undefined,
      onMessage: {
        addListener: (listener: typeof runtimeListeners[number]) => runtimeListeners.push(listener),
        removeListener: () => undefined,
      },
      sendMessage: (message: Record<string, unknown>, callback?: (response?: unknown) => void) => {
        sentMessages.push(message);
        callback?.(responseForMessage(message));
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  globals.window = window;
  globals.document = document;
  globals.chrome = chrome;
  globals.Node = { ELEMENT_NODE: 1 };
  globals.performance = {
    now: () => nowOverride ?? performanceNow(),
  };
  globals.requestAnimationFrame = (callback: () => void) => {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  globals.cancelAnimationFrame = (id: number) => animationFrames.delete(id);
  globals.setTimeout = scheduleTimer;
  globals.clearTimeout = clearTimer;
  const collector = new TelemetryCollector();

  function emit(type: string, event: Record<string, unknown>): void {
    for (const listener of windowListeners.get(type) ?? []) listener(event);
  }

  function emitNavigation(type: string): void {
    for (const listener of navigationListeners.get(type) ?? []) listener({});
  }

  function emitDocument(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of documentListeners.get(type) ?? []) listener(event);
  }

  function runAnimationFrame(): void {
    const first = animationFrames.entries().next().value as [number, () => void] | undefined;
    if (!first) return;
    animationFrames.delete(first[0]);
    first[1]();
  }

  return {
    collector,
    controls,
    overlays,
    styles,
    windowListeners,
    documentListeners,
    runtimeListeners,
    sentMessages,
    emit,
    emitNavigation,
    emitDocument,
    runAnimationFrame,
    enableFakeTimers() {
      fakeTimersEnabled = true;
    },
    timerDelays() {
      return [...fakeTimers.values()].map((timer) => timer.delay);
    },
    timerCount() {
      return fakeTimers.size;
    },
    runTimer(delay: number) {
      const timer = [...fakeTimers.entries()].find(([, entry]) => entry.delay === delay);
      if (!timer) return false;
      fakeTimers.delete(timer[0]);
      timer[1].callback();
      return true;
    },
    setVisibility(value: DocumentVisibilityState) {
      documentVisibilityState = value;
    },
    setUrl(value: string) {
      window.location.href = value;
      window.location.hostname = new URL(value).hostname;
      window.location.origin = new URL(value).origin;
    },
    getQuerySelectorAllCalls() {
      return querySelectorAllCalls;
    },
    setResponseForMessage(handler: (message: Record<string, unknown>) => unknown) {
      responseForMessage = handler;
    },
    setTrapsEnabled(value: boolean) {
      trapsEnabled = value;
    },
    setNativePatternEnabled(value: boolean) {
      nativePatternEnabled = value;
    },
    setNow(value: number | null) {
      nowOverride = value;
    },
    setScanControlCount(count: number, trapAtEnd = false) {
      scanControls = Array.from({ length: count }, (_, index) => {
        const isTrap = trapAtEnd && index === count - 1;
        const control = makeElement('input', { x: 900, y: 700, width: 10, height: 10 }, { type: 'text' });
        if (isTrap) {
          control.rect = { x: 100, y: 200, width: 200, height: 40 };
          control.tagName = 'BUTTON';
          control.type = 'submit';
        }
        styles.set(control, {
          opacity: '1',
          visibility: 'visible',
          display: isTrap ? 'block' : 'none',
          position: 'static',
          pointerEvents: 'auto',
        } as FakeStyle);
        return control;
      });
    },
    getPageIdentity() {
      let response: unknown;
      for (const listener of runtimeListeners) {
        listener({ type: 'GET_PAGE_IDENTITY' }, {} as chrome.runtime.MessageSender, (value) => {
          response = value;
        });
      }
      return response as { topologyScanComplete: boolean };
    },
    getTopologyProgress() {
      const collectorState = collector as unknown as {
        topologyScanControls: HTMLElement[];
        topologyScannedControls: Set<HTMLElement>;
        topologyCoveredControls: Set<HTMLElement>;
        topologyScanCursor: number;
        topologyScanComplete: boolean;
        topologyScanFrames: HTMLIFrameElement[];
        topologyScannedFrames: Set<HTMLIFrameElement>;
        topologyCoveredFrames: Set<HTMLIFrameElement>;
        topologyFrameCursor: number;
      };
      return {
        controls: collectorState.topologyScanControls.length,
        scannedControls: collectorState.topologyScannedControls.size,
        scannedControlsList: [...collectorState.topologyScannedControls],
        coveredControls: collectorState.topologyCoveredControls.size,
        controlCursor: collectorState.topologyScanCursor,
        frames: collectorState.topologyScanFrames.length,
        scannedFrames: collectorState.topologyScannedFrames.size,
        coveredFrames: collectorState.topologyCoveredFrames.size,
        frameCursor: collectorState.topologyFrameCursor,
        complete: collectorState.topologyScanComplete,
      };
    },
    appendScanControls(count: number) {
      const added: FakeElement[] = [];
      for (let index = 0; index < count; index++) {
        const control = makeElement('input', { x: 900, y: 700, width: 10, height: 10 }, { type: 'text' });
        styles.set(control, {
          opacity: '1',
          visibility: 'visible',
          display: 'none',
          position: 'static',
          pointerEvents: 'auto',
        } as FakeStyle);
        added.push(control);
      }
      scanControls = [...scanControls, ...added];
      return added;
    },
    addOverlayChild(index: number, tagName = 'span') {
      const child = makeElement(tagName, { ...overlays[index].rect });
      child.parentElement = overlays[index];
      overlays[index].children.push(child);
      childOverlays.set(index, child);
      return child;
    },
    replaceOverlay(index: number) {
      const replacement = makeElement('div', { ...controls[index].rect });
      styles.set(replacement, {
        opacity: '0',
        visibility: 'visible',
        display: 'block',
        position: 'fixed',
        pointerEvents: 'auto',
      } as FakeStyle);
      overlays[index] = replacement;
      return replacement;
    },
    restore() {
      collector.destroy();
      for (const key of Object.keys(original)) {
        if (original[key] === undefined) delete globals[key];
        else globals[key] = original[key];
      }
    },
  };
}

test('transient visual failure retries once and successful capture cancels recovery', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  const attempts: number[] = [];
  env.setResponseForMessage((message) => {
    const attempt = Number(message.visionRecoveryAttempt);
    attempts.push(attempt);
    return attempt === 0
      ? evaluationResponse(message, 'pending', 'capture_api_failure')
      : evaluationResponse(message, 'captured', null);
  });
  try {
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(attempts, [0]);
    assert.deepEqual(env.timerDelays(), [500]);
    assert.equal(env.runTimer(500), true);
    assert.deepEqual(attempts, [0, 1]);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('a model change during capture permits a bounded fresh-frame retry', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  const attempts: number[] = [];
  env.setResponseForMessage((message) => {
    const attempt = Number(message.visionRecoveryAttempt);
    attempts.push(attempt);
    return attempt === 0
      ? evaluationResponse(message, 'pending', 'model_changed')
      : evaluationResponse(message, 'captured', null);
  });
  try {
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(env.timerDelays(), [500]);
    assert.equal(env.runTimer(500), true);
    assert.deepEqual(attempts, [0, 1]);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('persistent visual failures exhaust attempt indices 0, 1, and 2 without looping', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  const attempts: number[] = [];
  env.setResponseForMessage((message) => {
    const attempt = Number(message.visionRecoveryAttempt);
    attempts.push(attempt);
    return evaluationResponse(
      message,
      attempt === 2 ? 'failed' : 'pending',
      'capture_api_failure'
    );
  });
  try {
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(env.timerDelays(), [500]);
    assert.equal(env.runTimer(500), true);
    // The synchronous sendMessage mock resolves evaluations immediately, so
    // the in-flight slot only frees after the async dispatch settles — drain
    // several microtask ticks before the next recovery dispatch.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(env.timerDelays(), [1500]);
    assert.equal(env.runTimer(1500), true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.equal(env.timerCount(), 0);

    await env.collector.dispatchTelemetryEvaluation(true);
    assert.deepEqual(attempts, [0, 1, 2, 2]);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('focus and visibility recovery coalesce and rescan a page without pointer samples', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  let responseCount = 0;
  env.setResponseForMessage((message) => {
    responseCount++;
    return responseCount === 1
      ? evaluationResponse(message, 'pending', 'capture_api_failure')
      : evaluationResponse(message, 'captured', null);
  });
  try {
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(env.timerDelays(), [500]);
    env.setVisibility('hidden');
    env.emit('focus', {});
    env.emitDocument('visibilitychange');
    assert.equal(env.timerCount(), 0);

    const scansBeforeResume = env.getQuerySelectorAllCalls();
    env.setVisibility('visible');
    env.emit('focus', {});
    env.emitDocument('visibilitychange');
    env.emit('focus', {});
    assert.deepEqual(env.timerDelays(), [100]);
    assert.equal(env.runTimer(100), true);

    assert.equal(env.sentMessages.length, 2);
    assert.equal(env.sentMessages[1].forceVision, true);
    assert.equal(env.sentMessages[1].visionRecoveryAttempt, 0);
    const payload = env.sentMessages[1].payload as Record<string, unknown>;
    assert.deepEqual(payload.pointerSeries, []);
    assert.ok(env.getQuerySelectorAllCalls() > scansBeforeResume);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('invalid or stale evaluation responses never schedule vision recovery', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  env.setResponseForMessage((message) => {
    const response = evaluationResponse(message, 'pending', 'decode_canvas_failure');
    return {
      ...response,
      result: { ...response.result, evaluationGeneration: Number(message.evaluationGeneration) + 1 },
    };
  });
  try {
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.equal(env.timerCount(), 0);

    env.setResponseForMessage(() => ({ success: true, result: { stale: true } }));
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('navigation, destruction, and warning UI cancel pending capture retries', async () => {
  const navigationEnv = setupCollectorEnvironment();
  navigationEnv.enableFakeTimers();
  navigationEnv.setTrapsEnabled(false);
  navigationEnv.setResponseForMessage((message) =>
    evaluationResponse(message, 'pending', 'capture_api_failure')
  );
  try {
    await navigationEnv.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(navigationEnv.timerDelays(), [500]);
    navigationEnv.setUrl('https://collector.example/next');
    navigationEnv.collector.resetSession('https://collector.example/next');
    assert.equal(navigationEnv.timerDelays().includes(500), false);
    navigationEnv.collector.destroy();
    assert.equal(navigationEnv.timerCount(), 0);
  } finally {
    navigationEnv.restore();
  }

  const destroyEnv = setupCollectorEnvironment();
  destroyEnv.enableFakeTimers();
  destroyEnv.setTrapsEnabled(false);
  destroyEnv.setResponseForMessage((message) =>
    evaluationResponse(message, 'pending', 'capture_api_failure')
  );
  try {
    await destroyEnv.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(destroyEnv.timerDelays(), [500]);
    destroyEnv.collector.destroy();
    assert.equal(destroyEnv.timerCount(), 0);
  } finally {
    destroyEnv.restore();
  }

  const warningEnv = setupCollectorEnvironment();
  warningEnv.enableFakeTimers();
  warningEnv.setTrapsEnabled(false);
  let warningResponseCount = 0;
  warningEnv.setResponseForMessage((message) => {
    warningResponseCount++;
    return warningResponseCount === 1
      ? evaluationResponse(message, 'pending', 'capture_api_failure')
      : evaluationResponse(message, 'suppressed', 'warning_visible_no_fresh_frame');
  });
  try {
    await warningEnv.collector.dispatchTelemetryEvaluation(true, true);
    assert.deepEqual(warningEnv.timerDelays(), [500]);
    const scansBeforeWarningResume = warningEnv.getQuerySelectorAllCalls();
    const warningRoot = makeElement('div', { x: 20, y: 20, width: 100, height: 50 });
    warningEnv.styles.set(warningRoot, {
      opacity: '1',
      visibility: 'visible',
      display: 'block',
      position: 'fixed',
      pointerEvents: 'auto',
    } as FakeStyle);
    (warningEnv.collector as unknown as {
      ownedWarningRoots: Map<'overlay' | 'banner' | 'toast', FakeElement>;
    }).ownedWarningRoots.set('banner', warningRoot);
    warningEnv.collector.renderWarning('banner');
    warningEnv.emit('focus', {});
    warningEnv.emitDocument('visibilitychange');
    assert.deepEqual(warningEnv.timerDelays(), [100]);
    assert.equal(warningEnv.runTimer(100), true);
    assert.equal(warningEnv.sentMessages.length, 2);
    assert.equal(warningEnv.sentMessages[1].forceVision, false);
    assert.equal(warningEnv.sentMessages[1].warningVisible, true);
    assert.equal(warningEnv.sentMessages[1].visionRecoveryAttempt, 1);
    const warningPayload = warningEnv.sentMessages[1].payload as Record<string, unknown>;
    assert.deepEqual(warningPayload.pointerSeries, []);
    assert.ok(warningEnv.getQuerySelectorAllCalls() > scansBeforeWarningResume);
    assert.equal(warningEnv.timerCount(), 0);
  } finally {
    warningEnv.restore();
  }
});

test('noncapturable pages never schedule a visual retry', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  let reason: VisionUnavailableReason = 'inactive_tab';
  env.setResponseForMessage((message) =>
    evaluationResponse(
      message,
      reason === 'restricted_url' ? 'restricted' : 'pending',
      reason
    )
  );
  try {
    for (const eventReason of ['inactive_tab', 'unfocused_window', 'page_changed'] as const) {
      reason = eventReason;
      await env.collector.dispatchTelemetryEvaluation(true, true);
      assert.equal(env.timerCount(), 0);
    }
    reason = 'restricted_url';
    await env.collector.dispatchTelemetryEvaluation(true, true);
    assert.equal(env.timerCount(), 0);
  } finally {
    env.restore();
  }
});

test('collector records zero-origin pointer kinematics and keeps a rolling 256-point buffer', async () => {
  const env = setupCollectorEnvironment();
  try {
    let timestamp = performance.now() + 10;
    env.emit('pointermove', {
      target: env.controls[0],
      clientX: 0,
      clientY: 0,
      timeStamp: timestamp,
    });
    env.runAnimationFrame();
    const first = env.collector.getTelemetryPayload().pointerSeries[0];
    assert.equal(first.dx, 0);
    assert.equal(first.dy, 0);
    assert.equal(first.velocity, 0);
    assert.equal(first.angle, 0);

    for (let index = 1; index <= 260; index++) {
      timestamp += 10;
      env.emit('pointermove', {
        target: env.controls[0],
        clientX: index,
        clientY: index * 2,
        timeStamp: timestamp,
      });
      env.runAnimationFrame();
      // The sendMessage mock resolves synchronously; draining a microtask
      // frees the one-in-flight slot the way an async message channel would.
      await Promise.resolve();
    }

    const telemetry = env.collector.getTelemetryPayload();
    assert.equal(telemetry.pointerSeries.length, 256);
    assert.ok(Math.abs((telemetry.pointerSeries.at(-1)?.x ?? -1) - 260 / 1280) < 0.00001);
    assert.ok(env.sentMessages.length > 10, 'rolling buffer length does not stop incremental dispatch');
  } finally {
    env.restore();
  }
});

test('collector cancels queued pointer moves before immediate down/up samples', () => {
  const env = setupCollectorEnvironment();
  try {
    const timestamp = performance.now() + 10;
    env.emit('pointermove', {
      target: env.controls[0],
      clientX: 80,
      clientY: 90,
      timeStamp: timestamp,
    });
    env.emit('pointerdown', {
      target: env.controls[0],
      clientX: 90,
      clientY: 100,
      timeStamp: timestamp + 10,
    });
    assert.equal(env.collector.getTelemetryPayload().pointerSeries.length, 1);
    env.runAnimationFrame();
    assert.equal(env.collector.getTelemetryPayload().pointerSeries.length, 1);
  } finally {
    env.restore();
  }
});

test('pointer timestamps are nonnegative and repeated keydowns do not create samples', async () => {
  const env = setupCollectorEnvironment();
  try {
    env.emit('pointermove', {
      target: env.controls[0],
      clientX: 80,
      clientY: 90,
      timeStamp: -100,
    });
    env.runAnimationFrame();
    assert.ok((env.collector.getTelemetryPayload().pointerSeries[0]?.timestamp ?? -1) >= 0);

    env.emit('keydown', { key: 'a', repeat: false });
    env.emit('keyup', { key: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    env.emit('keydown', { key: 'b', repeat: true });
    env.emit('keydown', { key: 'b', repeat: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    env.emit('keyup', { key: 'b' });

    const keys = env.collector.getTelemetryPayload().keystrokes;
    assert.equal(keys.length, 2);
    assert.ok(keys[1].flightTimeMs < keys[1].dwellTimeMs);
  } finally {
    env.restore();
  }
});

test('topology evidence requires persistent hit-test interception and identifies each covered control', async () => {
  const env = setupCollectorEnvironment();
  try {
    const firstScan = env.collector.scanDOMTopology();
    assert.equal(firstScan.filter((event) => event.isHitTestIntercepting).length, 0);
    env.replaceOverlay(0);
    await new Promise((resolve) => setTimeout(resolve, 280));
    await new Promise((resolve) => setTimeout(resolve, 280));
    const events = env.collector.scanDOMTopology();
    const traps = events.filter((event) => event.isHitTestIntercepting);
    assert.equal(traps.length, 2);
    assert.deepEqual(traps.map((event) => event.coveredControlType).sort(), ['password', 'submit']);
    assert.equal(new Set(traps.map((event) => event.evidenceId)).size, 2);
    assert.ok(traps.every((event) => event.evidenceSource === 'topology_scan'));
    assert.ok(traps.find((event) => event.coveredControlType === 'password')?.elementSelector.includes('div@'));
    env.setTrapsEnabled(false);
    assert.equal(env.collector.scanDOMTopology().filter((event) => event.isHitTestIntercepting).length, 0);
  } finally {
    env.restore();
  }
});

test('a different overlay over the same control must persist independently', () => {
  const env = setupCollectorEnvironment();
  try {
    const firstTime = performance.now();
    assert.equal(
      env.collector.scanDOMTopology().some((event) => event.coveredControlType === 'password'),
      false,
    );
    env.replaceOverlay(0);
    env.setNow(firstTime + 300);
    assert.equal(
      env.collector.scanDOMTopology().some((event) =>
        event.isHitTestIntercepting && event.coveredControlType === 'password'
      ),
      false,
    );
    assert.equal(
      env.collector.scanDOMTopology().some((event) =>
        event.isHitTestIntercepting && event.coveredControlType === 'password'
      ),
      false,
    );
    env.setNow(firstTime + 551);
    assert.equal(
      env.collector.scanDOMTopology().some((event) =>
        event.isHitTestIntercepting && event.coveredControlType === 'password'
      ),
      true,
    );
  } finally {
    env.restore();
  }
});

test('collector records unknown foreign frames without attributing top-level password fields', () => {
  const env = setupCollectorEnvironment();
  try {
    const frameEvent = env.collector.scanDOMTopology().find((event) => event.isCrossOriginIframe);
    assert.ok(frameEvent);
    assert.equal(frameEvent.isPasswordInput, false);
    assert.equal(frameEvent.credentialFrameEvidence, 'unverified');
    assert.equal(frameEvent.isHitTestIntercepting, false);
  } finally {
    env.restore();
  }
});

test('observed interceptions identify the underlying control through transparent ancestors', () => {
  for (const childType of ['span', 'svg']) {
    const env = setupCollectorEnvironment();
    try {
      env.emit('pointerdown', {
        target: env.addOverlayChild(0, childType),
        clientX: 120,
        clientY: 120,
        timeStamp: performance.now() + 10,
      });
      const event = env.collector.getTelemetryPayload().domEvents.find((item) => item.evidenceSource === 'observed_interaction');
      assert.ok(event);
      assert.equal(event.isHitTestIntercepting, true);
      assert.equal(event.coveredControlType, 'password');
      assert.equal(event.evidenceId?.startsWith('d0_e'), true);
      assert.equal(event.elementSelector.includes('auth-overlay-private-name'), false);
    } finally {
      env.restore();
    }
  }
});

test('native transparent checkbox patterns do not become overlay evidence and page IDs are not trusted', async () => {
  const env = setupCollectorEnvironment();
  try {
    env.overlays[0].id = 'phishguard-page-controlled';
    env.setNativePatternEnabled(true);
    assert.equal(
      env.collector.scanDOMTopology().filter((event) => event.isHitTestIntercepting).length,
      0,
    );
    env.setNativePatternEnabled(false);
    env.replaceOverlay(0).id = 'phishguard-page-controlled';
    assert.equal(env.collector.scanDOMTopology().filter((event) => event.isHitTestIntercepting).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 280));
    const events = env.collector.scanDOMTopology().filter((event) => event.isHitTestIntercepting);
    assert.equal(events.some((event) => event.coveredControlType === 'password'), true);
  } finally {
    env.restore();
  }
});

test('partial topology scans are reported as incomplete', () => {
  const env = setupCollectorEnvironment();
  try {
    env.setScanControlCount(1000);
    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, false);
  } finally {
    env.restore();
  }
});

test('budgeted topology passes eventually complete the control cycle and find a late trap', async () => {
  const env = setupCollectorEnvironment();
  try {
    env.setScanControlCount(1000, true);
    let complete = false;
    let foundLateTrap = false;
    for (let pass = 0; pass < 40 && !(complete && foundLateTrap); pass++) {
      const events = env.collector.scanDOMTopology();
      foundLateTrap ||= events.some((event) =>
        event.isHitTestIntercepting && event.coveredControlType === 'submit'
      );
      complete = env.getPageIdentity().topologyScanComplete;
      if (!(complete && foundLateTrap)) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(complete, true, JSON.stringify(env.getTopologyProgress()));
    assert.equal(foundLateTrap, true, JSON.stringify(env.getTopologyProgress()));
  } finally {
    env.restore();
  }
});

test('concurrent evaluations coalesce to one in-flight plus one latest pending intent', async () => {
  const env = setupCollectorEnvironment();
  try {
    const globals = globalThis as unknown as {
      chrome: { runtime: { sendMessage: (m: Record<string, unknown>, cb?: (r?: unknown) => void) => void } };
    };
    const sent: Array<Record<string, unknown>> = [];
    const callbacks: Array<(response?: unknown) => void> = [];
    globals.chrome.runtime.sendMessage = (message, callback) => {
      sent.push(message);
      callbacks.push(callback!);
    };

    const first = env.collector.dispatchTelemetryEvaluation();
    const superseded = env.collector.dispatchTelemetryEvaluation();
    const latest = env.collector.dispatchTelemetryEvaluation(false, true);

    // Only the first dispatch reached the wire; later calls collapse into a
    // single pending intent instead of queueing payloads.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'EVALUATE_TELEMETRY');
    assert.equal(sent[0].evaluationGeneration, 1);

    callbacks[0]?.({ success: true });
    assert.deepEqual(await first, { success: true });

    while (callbacks.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, 'EVALUATE_TELEMETRY');
    // Generation is only allocated on dispatch — the superseded intent leaves no gap.
    assert.equal(sent[1].evaluationGeneration, 2);
    // forceVision is merged across superseded intents: the earlier intent had
    // none, the latest request's true flag is preserved.
    assert.equal(sent[1].forceVision, true);

    const secondResponse = { success: true, servedPending: true };
    callbacks[1]?.(secondResponse);
    // Every coalesced caller shares the response of the dispatch that served
    // them — a superseded pending intent never resolves to a synthetic null.
    assert.deepEqual(await superseded, secondResponse);
    assert.deepEqual(await latest, secondResponse);
  } finally {
    env.restore();
  }
});

test('destroy resolves a pending coalesced evaluation with null and never dispatches it', async () => {
  const env = setupCollectorEnvironment();
  try {
    const globals = globalThis as unknown as {
      chrome: { runtime: { sendMessage: (m: Record<string, unknown>, cb?: (r?: unknown) => void) => void } };
    };
    const sent: Array<Record<string, unknown>> = [];
    const callbacks: Array<(response?: unknown) => void> = [];
    globals.chrome.runtime.sendMessage = (message, callback) => {
      sent.push(message);
      callbacks.push(callback!);
    };

    const first = env.collector.dispatchTelemetryEvaluation();
    const pending = env.collector.dispatchTelemetryEvaluation();
    assert.equal(sent.length, 1);

    env.collector.destroy();
    assert.equal(await pending, null, 'destroy resolves the pending intent with null');

    callbacks[0]?.({ success: true });
    assert.deepEqual(await first, { success: true });

    // The cleared pending intent is not dispatched after destruction.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
  } finally {
    env.restore();
  }
});

test('currententrychange after an SPA URL change resets the session and re-dispatches', () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    env.setUrl('https://collector.example/route-b');
    env.emitNavigation('currententrychange');

    // resetSession queues a fresh forced evaluation 150 ms out.
    assert.ok(env.timerDelays().includes(150), 'route reset schedules a fresh evaluation');
    assert.ok(env.runTimer(150));

    const evals = env.sentMessages.filter((m) => m.type === 'EVALUATE_TELEMETRY');
    assert.ok(evals.length >= 1);
    const last = evals.at(-1)!;
    assert.equal(last.url, 'https://collector.example/route-b');
    assert.equal(last.navigationGeneration, 1);
    assert.equal((last.payload as { url: string }).url, 'https://collector.example/route-b');
  } finally {
    env.restore();
  }
});

test('currententrychange with an unchanged URL does not reset the session', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    env.emitNavigation('currententrychange');
    assert.equal(env.timerDelays().includes(150), false, 'no reset when the URL did not move');

    await env.collector.dispatchTelemetryEvaluation(true);
    const last = env.sentMessages.at(-1);
    assert.equal(last?.type, 'EVALUATE_TELEMETRY');
    assert.equal(last?.navigationGeneration, 0);
    assert.equal(last?.url, 'https://collector.example/login');
  } finally {
    env.restore();
  }
});

test('PAGE_URL_CHANGED resyncs the session just like a detected route change', () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    env.setUrl('https://collector.example/route-c');
    for (const listener of env.runtimeListeners) {
      listener({ type: 'PAGE_URL_CHANGED', url: 'https://collector.example/route-c' }, {} as chrome.runtime.MessageSender, () => {});
    }

    assert.ok(env.timerDelays().includes(150), 'service-worker nudge triggers the reset');
    assert.ok(env.runTimer(150));
    const evals = env.sentMessages.filter((m) => m.type === 'EVALUATE_TELEMETRY');
    assert.ok(evals.length >= 1);
    assert.equal(evals.at(-1)!.url, 'https://collector.example/route-c');
    assert.equal(evals.at(-1)!.navigationGeneration, 1);
  } finally {
    env.restore();
  }
});

test('a dispatch after an unnoticed SPA URL change resyncs before sending', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    // Simulate a route change no detector reported.
    env.setUrl('https://collector.example/route-d');
    await env.collector.dispatchTelemetryEvaluation(true);

    const evals = env.sentMessages.filter((m) => m.type === 'EVALUATE_TELEMETRY');
    assert.ok(evals.length >= 1);
    const last = evals.at(-1)!;
    assert.equal(last.url, 'https://collector.example/route-d');
    assert.equal(last.navigationGeneration, 1);
    assert.equal((last.payload as { url: string }).url, 'https://collector.example/route-d');
  } finally {
    env.restore();
  }
});

test('collector works on insecure origins where crypto.randomUUID is undefined', async () => {
  const cryptoRef = globalThis.crypto as Crypto & { randomUUID?: unknown };
  const hadOwn = Object.prototype.hasOwnProperty.call(cryptoRef, 'randomUUID');
  const originalDescriptor = Object.getOwnPropertyDescriptor(cryptoRef, 'randomUUID');
  Object.defineProperty(cryptoRef, 'randomUUID', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const env = setupCollectorEnvironment();
  try {
    const telemetry = env.collector.getTelemetryPayload();
    assert.doesNotThrow(() => InteractionTelemetryPayloadSchema.parse(telemetry));
    const identity = env.getPageIdentity() as unknown as { pageSessionId: string };
    assert.match(telemetry.telemetryId, uuidV4);
    assert.match(identity.pageSessionId, uuidV4);
    assert.notEqual(telemetry.telemetryId, identity.pageSessionId);

    await env.collector.dispatchTelemetryEvaluation(true);
    assert.equal(env.sentMessages.at(-1)?.type, 'EVALUATE_TELEMETRY');
  } finally {
    env.restore();
    if (hadOwn && originalDescriptor) {
      Object.defineProperty(cryptoRef, 'randomUUID', originalDescriptor);
    } else {
      delete (cryptoRef as { randomUUID?: unknown }).randomUUID;
    }
  }
});

test('a topology refresh keeps completed coverage and restarts only the scan cycle', () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, true);

    env.emit('scroll', {});
    // The refresh clears only the current cycle: sticky coverage and the
    // completeness flag are untouched.
    const progress = env.getTopologyProgress();
    assert.equal(progress.scannedControls, 0);
    assert.equal(progress.coveredControls, 2);
    assert.equal(env.getPageIdentity().topologyScanComplete, true);

    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, true);
  } finally {
    env.restore();
  }
});

test('a new control is scanned first and holds the scan incomplete until covered', () => {
  const env = setupCollectorEnvironment();
  try {
    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, true);

    const added = env.appendScanControls(600);
    env.collector.scanDOMTopology();
    const progress = env.getTopologyProgress();
    // The pass starts at the first uncovered control; the 500-element budget
    // leaves an uncovered tail, so the scan reports incomplete again.
    assert.equal(progress.scannedControlsList[0], added[0]);
    assert.equal(progress.coveredControls, 502);
    assert.equal(env.getPageIdentity().topologyScanComplete, false);

    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, true);
    assert.equal(env.getTopologyProgress().coveredControls, 602);
  } finally {
    env.restore();
  }
});

test('a confirmed topology candidate survives a refresh', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  try {
    const start = performance.now();
    env.setNow(start);
    env.collector.scanDOMTopology();
    env.setNow(start + 300);
    const confirmed = env.collector.scanDOMTopology();
    assert.ok(confirmed.some((event) => event.isHitTestIntercepting));

    env.emit('scroll', {});
    assert.equal(env.getTopologyProgress().scannedControls, 0);
    const after = env.collector.scanDOMTopology();
    assert.ok(
      after.some((event) => event.isHitTestIntercepting),
      'a confirmed trap is still reported without re-confirmation'
    );
  } finally {
    env.restore();
  }
});

test('an uncovered page continues at 50 ms while a covered page throttles re-validation', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  try {
    env.setScanControlCount(1000);
    env.setNow(2000);
    // First coverage still advances at 50 ms continuation passes.
    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, false);
    assert.deepEqual(env.timerDelays(), [50]);
    env.collector.scanDOMTopology();
    assert.equal(env.getPageIdentity().topologyScanComplete, true);

    // A refresh clears only the cycle; the pending timer is not restarted.
    env.emit('scroll', {});
    assert.deepEqual(env.timerDelays(), [50]);
    assert.equal(env.runTimer(50), true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The cleared cycle re-validates, but because coverage is complete the
    // continuation is throttled — far above the 50 ms first-coverage pace.
    assert.deepEqual(env.timerDelays(), [1000]);
  } finally {
    env.restore();
  }
});

test('continuous refresh requests cannot starve the throttled dispatch', async () => {
  const env = setupCollectorEnvironment();
  env.enableFakeTimers();
  env.setTrapsEnabled(false);
  try {
    const evalsSent = () =>
      env.sentMessages.filter((m) => m.type === 'EVALUATE_TELEMETRY').length;

    env.setNow(2000);
    env.emit('scroll', {});
    env.emit('scroll', {});
    env.emit('scroll', {});
    // One pending dispatch; repeated requests never restart the timer.
    assert.deepEqual(env.timerDelays(), [250]);
    assert.equal(env.runTimer(250), true);
    // The synchronous sendMessage mock resolves immediately, but the
    // in-flight slot frees on a later microtask — drain several ticks.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(evalsSent(), 1);

    // A refresh 100 ms after the last dispatch is pushed out so dispatches
    // stay at least about a second apart.
    env.setNow(2100);
    env.emit('scroll', {});
    env.emit('scroll', {});
    assert.deepEqual(env.timerDelays(), [900]);
    assert.equal(env.runTimer(900), true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(evalsSent(), 2);

    env.setNow(4000);
    env.emit('scroll', {});
    assert.deepEqual(env.timerDelays(), [250]);
  } finally {
    env.restore();
  }
});

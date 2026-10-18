import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const contentScriptPath = fileURLToPath(new URL('../dist/content.js', import.meta.url));

test('built content script is a classic script without ESM declarations', () => {
  const contentScript = readFileSync(contentScriptPath, 'utf8');

  assert.doesNotMatch(
    contentScript,
    /\bimport\s*(?:\(|["'{*]|[\w$]+\s+from\b)|\bexport\s+(?:\{|\*|default\b|(?:async\s+)?(?:const|let|var|function|class)\b)/,
  );
  assert.doesNotThrow(() => new Script(contentScript, { filename: contentScriptPath }));
});

test('built content script starts and dispatches privacy-safe telemetry', async () => {
  const contentScript = readFileSync(contentScriptPath, 'utf8');
  const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const messageListeners: Array<
    (message: { type?: string; forceVision?: boolean }, sender: object, respond: (value?: unknown) => void) => unknown
  > = [];
  const messages: Array<{
    type: string;
    payload?: Record<string, unknown>;
    forceVision?: boolean;
    pageSessionId?: string;
    navigationGeneration?: number;
    evaluationGeneration?: number;
    url?: string;
    warningVisible?: boolean;
    topologyScanComplete?: boolean;
    visionRecoveryAttempt?: number;
  }> = [];
  const animationFrames: Array<() => void> = [];
  const timers: Array<{ id: number; delay: number; callback: () => void }> = [];
  let nextTimerId = 0;
  let currentTime = 100;

  const transparentElement = {
    tagName: 'DIV',
    nodeType: 1,
    id: '',
    className: 'transparent-trap',
    parentElement: null,
    isConnected: true,
    contains: () => false,
    closest: () => null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 40 }),
  };
  const passwordField = {
    tagName: 'INPUT',
    type: 'password',
    nodeType: 1,
    id: '',
    parentElement: null,
    isConnected: true,
    contains: () => false,
    closest: () => null,
    getAttribute: (name: string) => name === 'type' ? 'password' : null,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 40 }),
  };
  const document = {
    readyState: 'interactive',
    title: 'Smoke Test',
    querySelector: (selector: string) => selector === 'input[type="password"]' ? passwordField : null,
    querySelectorAll: (selector: string) => selector === 'iframe' ? [] : [passwordField],
    elementsFromPoint: () => [transparentElement, passwordField],
    getElementById: () => null,
  };
  const queueTimer = (callback: () => void, delay = 0): number => {
    const id = ++nextTimerId;
    timers.push({ id, delay, callback });
    return id;
  };
  const clearTimer = (id: number): void => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const window = {
    location: {
      href: 'https://smoke.example.test/login',
      hostname: 'smoke.example.test',
      origin: 'https://smoke.example.test',
    },
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout: queueTimer,
    getComputedStyle: (element: typeof transparentElement | typeof passwordField) => ({
      opacity: element === transparentElement ? '0' : '1',
      visibility: 'visible',
      display: 'block',
      position: element === transparentElement ? 'fixed' : 'static',
      pointerEvents: 'auto',
    }),
  };
  const chrome = {
    runtime: {
      id: 'runtime-smoke-id',
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://runtime-smoke-id/${path}`,
      onMessage: {
        addListener: (listener: (message: { type?: string; forceVision?: boolean }, sender: object, respond: (value?: unknown) => void) => unknown) => {
          messageListeners.push(listener);
        },
        removeListener: () => undefined,
      },
      sendMessage: (
        message: {
          type: string;
          payload?: Record<string, unknown>;
          forceVision?: boolean;
          pageSessionId?: string;
          navigationGeneration?: number;
          evaluationGeneration?: number;
          url?: string;
          warningVisible?: boolean;
          topologyScanComplete?: boolean;
          visionRecoveryAttempt?: number;
        },
        callback?: (response?: unknown) => void,
      ) => {
        messages.push(message);
        callback?.({ accepted: true });
      },
    },
    storage: {
      local: {
        get: async () => ({}),
      },
    },
  };
  const history = {
    pushState: () => undefined,
    replaceState: () => undefined,
  };

  new Script(contentScript, { filename: contentScriptPath }).runInNewContext({
    AbortController,
    Node: { ELEMENT_NODE: 1 },
    chrome,
    clearTimeout: clearTimer,
    console: { debug: () => undefined },
    crypto: { randomUUID: () => 'runtime-smoke-telemetry-id' },
    document,
    history,
    performance: { now: () => currentTime++ },
    requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
    setTimeout: queueTimer,
    cancelAnimationFrame: () => undefined,
    window,
    URL,
  });

  const startupTimerIndex = timers.findIndex((timer) => timer.delay === 250);
  assert.notEqual(startupTimerIndex, -1, 'interactive document should queue its startup evaluation');
  timers.splice(startupTimerIndex, 1)[0].callback();
  // The dispatched evaluation resolves over several microtasks (the async
  // dispatch adopts the sendMessage promise); drain them so the in-flight
  // slot is released before the follow-up dispatch is requested.
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const startupMessage = messages[0];
  assert.equal(startupMessage?.type, 'EVALUATE_TELEMETRY');
  assert.equal(startupMessage?.forceVision, true);
  assert.equal(startupMessage?.payload?.hasCredentialField, true);
  assert.equal((startupMessage?.payload?.domEvents as unknown[]).length, 0);
  assert.equal(typeof startupMessage?.pageSessionId, 'string');
  assert.equal(startupMessage?.navigationGeneration, 0);
  assert.equal(startupMessage?.evaluationGeneration, 1);
  assert.equal(startupMessage?.visionRecoveryAttempt, 0);

  const confirmationIndex = timers.findIndex((timer) => timer.delay === 250);
  assert.notEqual(confirmationIndex, -1, 'topology candidates schedule an explicit follow-up scan');
  currentTime += 300;
  timers.splice(confirmationIndex, 1)[0].callback();
  const confirmedMessage = messages.at(-1);
  const topologyEvents = confirmedMessage?.payload?.domEvents as Array<Record<string, unknown>>;
  assert.equal(topologyEvents.length, 1);
  assert.equal(topologyEvents[0].evidenceSource, 'topology_scan');
  assert.equal(topologyEvents[0].isHitTestIntercepting, true);
  assert.equal(topologyEvents[0].coveredControlType, 'password');
  for (let i = 0; i < 5; i++) await Promise.resolve();

  for (const listener of windowListeners.get('pointermove') ?? []) {
    listener({ clientX: 210, clientY: 160, timeStamp: currentTime++ });
  }
  assert.equal(animationFrames.length, 1);
  animationFrames.shift()?.();

  const pointerPayload = messages.at(-1)?.payload;
  assert.ok((pointerPayload?.pointerSeries as unknown[]).length > 0);

  const rawCode = 'KeyZ_runtime_smoke_secret';
  for (const listener of windowListeners.get('keydown') ?? []) {
    listener({ key: 'Z', code: rawCode });
  }
  for (const listener of windowListeners.get('keyup') ?? []) {
    listener({ key: 'Z', code: rawCode });
  }

  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(messageListeners.length, 1);
  const handled = messageListeners[0](
    { type: 'REQUEST_TELEMETRY_EVALUATION' },
    {},
    () => undefined,
  );
  assert.equal(handled, true);

  const telemetryPayload = messages.at(-1)?.payload;
  const keystrokes = telemetryPayload?.keystrokes as Array<Record<string, unknown>>;
  assert.equal(keystrokes[0]?.category, 'ALPHANUMERIC');
  const serializedPayload = JSON.stringify(telemetryPayload);
  assert.equal(serializedPayload.includes('"Z"'), false);
  assert.equal(serializedPayload.includes(rawCode), false);
  assert.doesNotMatch(serializedPayload, /"(?:key|code)"\s*:/);
});

test('content-script reinjection requests a fresh forced evaluation from the live collector', () => {
  const contentScript = readFileSync(contentScriptPath, 'utf8');
  const calls: Array<[boolean, boolean]> = [];
  const existingCollector = {
    isOrphaned: () => false,
    dispatchTelemetryEvaluation: (force: boolean, forceVision: boolean) => {
      calls.push([force, forceVision]);
      return Promise.resolve(null);
    },
  };
  const window = {
    location: { hostname: 'smoke.example.test' },
    __PHISHGUARD_COLLECTOR__: existingCollector,
  };

  new Script(contentScript, { filename: contentScriptPath }).runInNewContext({
    console: { debug: () => undefined },
    window,
  });

  assert.deepEqual(calls, [[true, true]]);
  assert.equal(window.__PHISHGUARD_COLLECTOR__, existingCollector);
});

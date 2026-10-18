import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

interface StubElement {
  id: string;
  textContent: string;
  className: string;
  innerHTML: string;
  title: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  style: Record<string, string>;
  children: StubElement[];
  listeners: Map<string, Array<() => void>>;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => void;
    contains: (name: string) => boolean;
  };
  addEventListener: (type: string, listener: () => void) => void;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  appendChild: (child: StubElement) => void;
}

function makeElement(id: string): StubElement {
  const classes = new Set<string>();
  const element: StubElement = {
    id,
    textContent: '',
    className: '',
    innerHTML: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    children: [],
    listeners: new Map(),
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const add = force ?? !classes.has(name);
        if (add) classes.add(name); else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    addEventListener(type, listener) {
      const list = element.listeners.get(type) ?? [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    setAttribute() {},
    removeAttribute() {},
    appendChild(child) {
      element.children.push(child);
    },
  };
  return element;
}

// The popup module registers a single DOMContentLoaded listener at import
// time, so the document object must stay stable across tests; per-test state
// lives behind these swappable slots.
const elements = new Map<string, StubElement>();
let domContentLoaded: (() => Promise<void>) | null = null;
const documentStub = {
  getElementById: (id: string) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement: (tag: string) => makeElement(tag),
  addEventListener: (type: string, listener: () => Promise<void>) => {
    if (type === 'DOMContentLoaded') domContentLoaded = listener;
  },
};

const timers = new Map<number, { delay: number; callback: () => void }>();
let nextTimerId = 1;
const scheduleTimer = (callback: () => void, delay = 0) => {
  const id = nextTimerId++;
  timers.set(id, { delay, callback });
  return id;
};
const clearTimer = (id?: number) => {
  if (id !== undefined) timers.delete(id);
};
const windowStub = {
  setTimeout: scheduleTimer,
  clearTimeout: clearTimer,
  open: () => undefined,
  addEventListener: () => undefined,
};
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

interface DeferredMessage {
  message: Record<string, unknown>;
  callback: (response?: unknown) => void;
}

let analysisRequests: DeferredMessage[] = [];
let tabMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
let scriptInjections: Array<{ target: { tabId: number }; files: string[] }> = [];
let runtimeListeners: Array<(message: Record<string, unknown>) => void> = [];
let tabMessageResponse: ((callIndex: number) => unknown) | null = null;
let evaluationRequests: DeferredMessage[] = [];
let evaluationResponse: unknown = { success: true, response: null };
let tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string }) => void> = [];

function makeChromeMock() {
  return {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      onMessage: {
        addListener: (listener: (message: Record<string, unknown>) => void) => {
          runtimeListeners.push(listener);
        },
      },
      sendMessage: (message: Record<string, unknown>, callback?: (response?: unknown) => void) => {
        if (message.type === 'GET_TAB_ANALYSIS') {
          analysisRequests.push({ message, callback: callback! });
          return;
        }
        if (message.type === 'REQUEST_TAB_EVALUATION') {
          evaluationRequests.push({ message, callback: callback! });
          callback?.(evaluationResponse);
          return;
        }
        if (message.type === 'GET_MODEL_STATUS') {
          callback?.({
            runtimeState: 'ready',
            status: {
              currentVersion: '1.5.0',
              latestAvailableVersion: '1.5.0',
              isLatest: true,
              lastSyncAttempt: new Date().toISOString(),
              syncState: 'ONLINE_SYNCED',
              backendReachable: true,
              modelSource: 'LOCAL_BUNDLED',
            },
          });
          return;
        }
        if (message.type === 'GET_EXTENSION_UPDATE_STATUS') {
          callback?.({
            success: true,
            status: {
              currentVersion: '0.5.1',
              latestVersion: '0.5.1',
              updateAvailable: false,
              updateChannel: 'NATIVE',
            },
          });
          return;
        }
        callback?.({ success: true });
      },
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://popup.example/login', active: true }],
      sendMessage: (
        tabId: number,
        message: Record<string, unknown>,
        callback?: (response?: unknown) => void
      ) => {
        tabMessages.push({ tabId, message });
        callback?.(tabMessageResponse ? tabMessageResponse(tabMessages.length) : undefined);
      },
      onUpdated: {
        addListener: (listener: (tabId: number, changeInfo: { url?: string }) => void) => {
          tabUpdatedListeners.push(listener);
        },
        removeListener: (listener: (tabId: number, changeInfo: { url?: string }) => void) => {
          tabUpdatedListeners = tabUpdatedListeners.filter((entry) => entry !== listener);
        },
      },
    },
    scripting: {
      executeScript: async (details: { target: { tabId: number }; files: string[] }) => {
        scriptInjections.push(details);
        return [];
      },
    },
    storage: {
      local: {
        get: (_keys: unknown, callback?: (res: Record<string, unknown>) => void) => callback?.({}),
        set: async () => {},
      },
      onChanged: { addListener: () => {} },
    },
  };
}

const globals = globalThis as unknown as Record<string, unknown>;
const originalGlobals: Record<string, unknown> = {};
for (const key of ['document', 'window', 'chrome', 'alert', 'setTimeout', 'clearTimeout']) {
  originalGlobals[key] = globals[key];
}
globals.document = documentStub;
globals.window = windowStub;
globals.alert = () => undefined;
globals.setTimeout = scheduleTimer as unknown as typeof setTimeout;
globals.clearTimeout = clearTimer as unknown as typeof clearTimeout;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  }
}

before(async () => {
  globals.chrome = makeChromeMock();
  await import('../popup/popup.ts');
  assert.ok(domContentLoaded, 'popup registers DOMContentLoaded listener');
});

function resetPopupState(): void {
  elements.clear();
  timers.clear();
  analysisRequests = [];
  tabMessages = [];
  scriptInjections = [];
  runtimeListeners = [];
  tabMessageResponse = null;
  evaluationRequests = [];
  evaluationResponse = { success: true, response: null };
  tabUpdatedListeners = [];
  globals.chrome = makeChromeMock();
}

async function openPopup(): Promise<void> {
  await domContentLoaded!();
  await flush();
}

function runTimer(delay: number): number {
  let fired = 0;
  for (const [id, timer] of [...timers.entries()]) {
    if (timer.delay === delay) {
      timers.delete(id);
      timer.callback();
      fired++;
    }
  }
  return fired;
}

function emitRuntimeMessage(message: Record<string, unknown>): void {
  for (const listener of runtimeListeners) listener(message);
}

function emitTabUpdated(tabId: number, changeInfo: { url?: string }): void {
  for (const listener of [...tabUpdatedListeners]) listener(tabId, changeInfo);
}

function analysisSnapshot(url: string, riskScore: number, tabId = 7) {
  return {
    success: true,
    snapshot: {
      tabId,
      pageSessionId: 'sess-1',
      navigationGeneration: 0,
      evaluationGeneration: 1,
      url,
      warningVisible: false,
      topologyScanComplete: true,
      telemetryId: 'telemetry-1',
      analysis: {
        url,
        domain: 'popup.example',
        telemetryId: 'telemetry-1',
        pageSessionId: 'sess-1',
        navigationGeneration: 0,
        evaluationGeneration: 1,
        riskScore,
        action: riskScore < 0.15 ? 'SAFE' : 'AMBIGUOUS',
        evaluatedAt: new Date().toISOString(),
        pointerSamples: 10,
        keystrokeSamples: 0,
        domAnomalies: 0,
        signals: {
          interaction: {
            score: null,
            status: 'skipped',
            detail: 'Behavioral input unavailable',
            samples: 0,
            explainability: {
              available: false,
              validPointCount: 0,
              durationMs: 0,
              invalidReason: 'insufficient coverage',
            },
          },
          page: {
            score: 0.05,
            status: 'ok',
            detail: 'No verified page evidence',
            anomalies: 0,
            explainability: { ruleIds: [], reasons: [] },
          },
          vision: {
            score: null,
            status: 'skipped',
            detail: 'Visual capture unavailable',
            explainability: { available: false, captureReason: null, captureState: 'failed' },
          },
          fused: {
            score: 0.05,
            modelScore: 0.05,
            evidenceScore: 0.05,
            modelStatus: 'available',
            modelContract: 'legacy',
            reasons: [],
            ruleIds: [],
            modelVersion: '1.5.0',
            modelHash: 'a'.repeat(64),
            inputContractIdentifier: 'student-v1',
            coverage: {
              trajectoryAvailable: false,
              validPointCount: 0,
              durationMs: 0,
              visualAvailable: false,
              pageContextAvailable: true,
              topologyScanComplete: true,
            },
          },
        },
      },
      cloudVerdict: null,
    },
  };
}

after(() => {
  for (const key of Object.keys(originalGlobals)) {
    if (originalGlobals[key] === undefined) delete globals[key];
    else globals[key] = originalGlobals[key];
  }
});

test('popup ignores stale out-of-order analysis responses and keeps the newest snapshot', async () => {
  resetPopupState();
  await openPopup();

  // The open flow issues the instant display fetch plus the re-fetch that
  // follows the (mock-resolved) evaluation request.
  assert.equal(analysisRequests.length, 2);

  // A progress completion issues a third, newer request.
  emitRuntimeMessage({
    type: 'ANALYSIS_PROGRESS',
    tabId: 7,
    url: 'https://popup.example/login',
    phase: 'completed',
  });
  await flush();
  assert.equal(analysisRequests.length, 3);

  // The earlier response arrives late and must be discarded.
  analysisRequests[0].callback(analysisSnapshot('https://popup.example/login', 0.05));
  await flush();
  assert.notEqual(elements.get('risk-score')!.textContent, '5%');

  analysisRequests[2].callback(analysisSnapshot('https://popup.example/login', 0.5));
  await flush();
  assert.equal(elements.get('risk-score')!.textContent, '50%');
  assert.equal(elements.get('status-badge')!.textContent, 'AMBIGUOUS');
});

test('popup keeps the last verdict with a refreshing hint while re-analyzing', async () => {
  resetPopupState();
  await openPopup();

  // The completed snapshot must exist before it can be shown as display-only.
  // analysisRequests[1] is the latest fetch issued by the open flow.
  analysisRequests[1].callback(analysisSnapshot('https://popup.example/login', 0.05));
  await flush();
  assert.equal(elements.get('status-badge')!.textContent, 'SAFE');

  emitRuntimeMessage({
    type: 'ANALYSIS_PROGRESS',
    tabId: 7,
    url: 'https://popup.example/login',
    phase: 'analyzing',
  });
  await flush();

  // The completed verdict stays on the badge while the refresh runs — never
  // a fresh SAFE; the phase text moves to the cloud line and cloud actions
  // stay disabled.
  const badge = elements.get('status-badge')!;
  assert.equal(badge.textContent, 'SAFE');
  assert.equal(badge.className, 'badge badge-safe badge-refreshing');
  assert.equal(elements.get('risk-score')!.textContent, '5%');
  assert.equal(elements.get('btn-escalate')!.disabled, true);
  assert.match(elements.get('cloud-desc')!.textContent, /analysis/i);

  runTimer(10_000);
  await flush();
  assert.match(elements.get('cloud-desc')!.textContent, /taking longer/i);
  // The retry affordance stays available; nothing claims the work cancelled.
  assert.equal(elements.get('btn-inspect')!.textContent, 'Re-evaluate Page');
});

test('popup shows CHECKING when the user re-evaluates the page', async () => {
  resetPopupState();
  await openPopup();
  analysisRequests[1].callback(analysisSnapshot('https://popup.example/login', 0.05));
  await flush();
  assert.equal(elements.get('status-badge')!.textContent, 'SAFE');

  const inspect = elements.get('btn-inspect')!;
  for (const listener of inspect.listeners.get('click') ?? []) listener();
  await flush();

  // A user-initiated check drops the kept verdict and returns to CHECKING.
  assert.equal(elements.get('status-badge')!.textContent, 'CHECKING');

  emitRuntimeMessage({
    type: 'ANALYSIS_PROGRESS',
    tabId: 7,
    url: 'https://popup.example/login',
    phase: 'analyzing',
  });
  await flush();
  assert.equal(elements.get('status-badge')!.textContent, 'CHECKING');
});

test('popup keeps SAFE through a brief topology-only LIMITED on the same page', async () => {
  resetPopupState();
  await openPopup();
  analysisRequests[1].callback(analysisSnapshot('https://popup.example/login', 0.05));
  await flush();
  assert.equal(elements.get('status-badge')!.textContent, 'SAFE');

  // A completed same-page analysis whose topology re-scan is still running
  // would present LIMITED; the coverage hold keeps the SAFE verdict.
  const rescanning = analysisSnapshot('https://popup.example/login', 0.05);
  rescanning.snapshot.topologyScanComplete = false;
  (
    rescanning.snapshot.analysis.signals.fused.coverage as { topologyScanComplete: boolean }
  ).topologyScanComplete = false;
  emitRuntimeMessage({
    type: 'ANALYSIS_PROGRESS',
    tabId: 7,
    url: 'https://popup.example/login',
    phase: 'completed',
  });
  await flush();
  analysisRequests.at(-1)!.callback(rescanning);
  await flush();

  assert.equal(elements.get('status-badge')!.textContent, 'SAFE');
  assert.equal(elements.get('risk-score')!.textContent, '5%');
});

test('popup delegates collector recovery to the background REQUEST_TAB_EVALUATION', async () => {
  resetPopupState();
  await openPopup();

  // The popup never injects or messages the tab collector itself: the
  // service worker owns the once-per-document injection guard.
  assert.equal(scriptInjections.length, 0);
  const evalRequests = tabMessages.filter(
    (entry) => entry.message.type === 'REQUEST_TELEMETRY_EVALUATION'
  );
  assert.equal(evalRequests.length, 0);
  assert.equal(evaluationRequests.length, 1);
  assert.equal(evaluationRequests[0].message.type, 'REQUEST_TAB_EVALUATION');
  assert.equal(evaluationRequests[0].message.tabId, 7);
  assert.equal(evaluationRequests[0].message.forceVision, true);
});

test('popup explains restricted pages instead of showing NOT ASSESSED', async () => {
  resetPopupState();
  evaluationResponse = { success: false, reason: 'restricted' };
  await openPopup();
  await flush();
  assert.equal(elements.get('status-badge')!.textContent, 'RESTRICTED');
  assert.match(elements.get('cloud-desc')!.textContent, /can't analyze this page/);
});

test('popup resyncs and re-evaluates when the active tab URL changes in place', async () => {
  resetPopupState();
  await openPopup();
  assert.equal(analysisRequests.length, 2);
  assert.equal(evaluationRequests.length, 1);

  // Events for other tabs and for the URL already tracked are ignored.
  emitTabUpdated(99, { url: 'https://popup.example/route-b' });
  emitTabUpdated(7, { url: 'https://popup.example/login' });
  await flush();
  assert.equal(analysisRequests.length, 2);

  emitTabUpdated(7, { url: 'https://popup.example/route-b' });
  await flush();

  // The popup re-points at the new route and restarts fetch + evaluation.
  // analysisRequests[2] is the superseded instant fetch; [3] is the live
  // re-fetch issued after the evaluation request resolved.
  assert.equal(elements.get('domain-text')!.textContent, 'https://popup.example/route-b');
  assert.equal(analysisRequests.length, 4);
  assert.equal(analysisRequests[2].message.url, 'https://popup.example/route-b');
  assert.equal(analysisRequests[3].message.url, 'https://popup.example/route-b');
  assert.equal(evaluationRequests.length, 2);
  assert.equal(evaluationRequests[1].message.tabId, 7);

  // A late response bound to the previous URL is generation-discarded.
  analysisRequests[1].callback(analysisSnapshot('https://popup.example/login', 0.5));
  await flush();
  assert.notEqual(elements.get('risk-score')!.textContent, '50%');

  analysisRequests[3].callback(analysisSnapshot('https://popup.example/route-b', 0.05));
  await flush();
  assert.equal(elements.get('risk-score')!.textContent, '5%');
  assert.equal(elements.get('status-badge')!.textContent, 'SAFE');
});

test('popup shows the restricted page when the tab moves to a non-http URL', async () => {
  resetPopupState();
  await openPopup();
  emitTabUpdated(7, { url: 'chrome://settings' });
  await flush();
  assert.equal(elements.get('domain-text')!.textContent, 'chrome://settings');
  assert.equal(elements.get('status-badge')!.textContent, 'RESTRICTED');
  assert.match(elements.get('cloud-desc')!.textContent, /can't analyze this page/);
});

test('popup flags the vision row when a displayed brand logo is unauthorized', async () => {
  resetPopupState();
  await openPopup();
  const snapshot = analysisSnapshot('https://popup.example/login', 0.4);
  const vision = snapshot.snapshot.analysis.signals.vision as {
    status: string;
    explainability: {
      brandLogoMismatch?: string[];
      brandLogoReason?: string | null;
    };
  };
  vision.status = 'flag';
  vision.explainability.brandLogoMismatch = ['paypal'];
  vision.explainability.brandLogoReason =
    'Displayed PayPal logo is not authorized for popup.example';
  analysisRequests[1].callback(snapshot);
  await flush();
  assert.equal(elements.get('cue-vision')!.textContent, 'LOGO MISMATCH');
  assert.equal(elements.get('cue-vision')!.className, 'cue-pill cue-pill-flag');
  assert.match(
    elements.get('sig-vision-detail')!.textContent,
    /Displayed PayPal logo is not authorized for popup\.example/
  );
  assert.equal(elements.get('explain-vision-status')!.textContent, 'LOGO MISMATCH');
  assert.equal(elements.get('explain-vision-status')!.className, 'explain-badge badge-warn');
  assert.match(
    elements.get('explain-vision-layout')!.textContent,
    /^Displayed PayPal logo is not authorized for popup\.example/
  );
});

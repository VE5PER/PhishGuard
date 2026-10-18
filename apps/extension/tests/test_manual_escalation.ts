import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTabCloudVerdict,
  handleTelemetryEvaluation,
  handleManualEscalation,
  handleTabUpdated,
  tabAnalysisStore,
} from '../src/background/service-worker.ts';
import { sqliteStorage } from '../src/background/sqlite-storage.ts';
import type { InteractionTelemetryPayload } from '@phishguard/types';

// Setup chrome mock environment for service worker testing
function setupChromeMock() {
  const store: Record<string, any> = {};
  const sentMessages: Array<{ tabId: number; message: any }> = [];
  let currentUrl = 'https://login-portal.example-auth.com/verify';

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[] | string) => {
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }
          const res: Record<string, any> = {};
          for (const k of keys) {
            if (k in store) res[k] = store[k];
          }
          return res;
        },
        set: async (items: Record<string, any>) => {
          Object.assign(store, items);
        },
        remove: async (keys: string[] | string) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) {
            delete store[k];
          }
        },
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    tabs: {
      get: async (tabId: number) => ({ id: tabId, url: currentUrl }),
      sendMessage: (tabId: number, message: any, callback?: (response?: unknown) => void) => {
        sentMessages.push({ tabId, message });
        if (message.type === 'GET_PAGE_IDENTITY') {
          const snapshot = tabAnalysisStore.get(tabId);
          callback?.(snapshot ? {
            pageSessionId: snapshot.pageSessionId,
            navigationGeneration: snapshot.navigationGeneration,
            evaluationGeneration: snapshot.evaluationGeneration,
            url: snapshot.url,
            warningVisible: snapshot.warningVisible,
            topologyScanComplete: snapshot.topologyScanComplete,
          } : undefined);
        } else {
          callback?.({ success: true });
        }
      },
    },
  };

  return {
    store,
    sentMessages,
    setUrl(url: string) {
      currentUrl = url;
    },
  };
}

test('handleTelemetryEvaluation NEVER automatically escalates ambiguous interactions', async () => {
  const { store } = setupChromeMock();
  handleTabUpdated(101, { status: 'loading' });
  const originalFetch = globalThis.fetch;
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  const fetchCalls: string[] = [];
  sqliteStorage.recordInspection = async () => {};

  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response;
  }) as any;

  try {
    // Ambiguous payload (moderate DOM interaction triggering 0.15 - 0.85 score)
    const ambiguousPayload: InteractionTelemetryPayload = {
      telemetryId: '33333333-3333-3333-3333-333333333333',
      url: 'https://login-portal.example-auth.com/verify',
      domain: 'login-portal.example-auth.com',
      pageTitle: 'Sign In Verification',
      sessionDurationMs: 1500,
      pointerSeries: [
        { x: 0.2, y: 0.3, dx: 1, dy: 1, velocity: 0.05, acceleration: 0, angle: 0.2, timestamp: 10, eventType: 'move' },
        { x: 0.4, y: 0.5, dx: 2, dy: 2, velocity: 0.08, acceleration: 0, angle: 0.3, timestamp: 30, eventType: 'down' },
      ],
      keystrokes: [],
      domEvents: [
        {
          eventType: 'click',
          targetBoundingBox: { x: 10, y: 10, width: 200, height: 40 },
          isZeroOpacity: true, // +0.35 risk
          isCrossOriginIframe: false,
          isPasswordInput: false,
          isPasteIntoPassword: false,
          elementSelector: 'button@e1',
          timestamp: 50,
          evidenceSource: 'topology_scan',
          evidenceId: 'control-1',
          isHitTestIntercepting: true,
          coveredControlType: 'password',
          credentialFrameEvidence: 'none',
        },
      ],
      hasCredentialField: true,
      clientTimestamp: new Date().toISOString(),
    };

    await handleTelemetryEvaluation(ambiguousPayload, 101);

    // Assert that NO call to /v1/escalate occurred automatically!
    const escalateCalls = fetchCalls.filter((c) => c.includes('/v1/escalate'));
    assert.equal(escalateCalls.length, 0, 'Must NOT make any network calls to /v1/escalate automatically');

    // Assert that local analysis is stored for the user to view in the popup
    const snapshot = tabAnalysisStore.get(101);
    assert.ok(snapshot, 'analysis is owned by the originating tab');
    assert.equal(snapshot.analysis.domain, 'login-portal.example-auth.com');
    assert.equal(snapshot.analysis.action, 'AMBIGUOUS');
    assert.equal(snapshot.analysis.canEscalate, true);
    assert.equal(snapshot.analysis.domAnomalies, 1);
    assert.equal((snapshot.analysis.signals as any).page.status, 'flag');
    assert.equal(
      (snapshot.analysis.signals as any).page.detail,
      'A persistent transparent overlay intercepts an interactive control',
    );
    assert.equal((snapshot.analysis.signals as any).vision.status, 'skipped');
    assert.equal(store.latestAnalysis, undefined);
    assert.equal(store.cloudVerdict, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('handleManualEscalation refuses unnegotiated evidence telemetry without using another tab snapshot', async () => {
  const { sentMessages } = setupChromeMock();
  handleTabUpdated(101, { status: 'loading' });
  const originalFetch = globalThis.fetch;
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  let escalationCalls = 0;
  sqliteStorage.recordInspection = async () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes('/v1/escalate')) escalationCalls++;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as any;

  try {
    const currentPayload: InteractionTelemetryPayload = {
      telemetryId: '33333333-3333-3333-3333-333333333333',
      url: 'https://login-portal.example-auth.com/verify',
      domain: 'login-portal.example-auth.com',
      pageTitle: 'Sign In Verification',
      sessionDurationMs: 1000,
      pointerSeries: [],
      keystrokes: [],
      domEvents: [],
      hasCredentialField: true,
      clientTimestamp: new Date().toISOString(),
    };
    await handleTelemetryEvaluation(currentPayload, 101);
    const snapshot = tabAnalysisStore.get(101);
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
    await assert.rejects(handleManualEscalation(101, false, reference), /CLOUD_UPGRADE_REQUIRED/);
    await assert.rejects(handleManualEscalation(202, false, reference), /No local interaction telemetry/);
    assert.equal(escalationCalls, 0);
    assert.equal(
      sentMessages.filter((entry) =>
        entry.tabId === 202 && entry.message.type === 'REQUEST_TELEMETRY_EVALUATION'
      ).length,
      1,
    );
    assert.equal(sentMessages.some((entry) => entry.message.type === 'SHOW_PHISHING_BANNER'), false);
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('handleManualEscalation maps a gateway timeout to a clear error', async () => {
  setupChromeMock();
  handleTabUpdated(101, { status: 'loading' });
  const originalFetch = globalThis.fetch;
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  let escalationSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/health')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          capabilities: {
            telemetryEvidenceVersion: 2,
            modelInputContracts: ['student-v1', 'student-v2'],
            manualEscalation: true,
          },
        }),
      } as unknown as Response;
    }
    escalationSignal = init?.signal;
    throw new DOMException('The operation timed out.', 'TimeoutError');
  }) as any;

  try {
    await handleTelemetryEvaluation({
      telemetryId: '88888888-8888-4888-8888-888888888888',
      url: 'https://login-portal.example-auth.com/verify',
      domain: 'login-portal.example-auth.com',
      pageTitle: 'Sign In Verification',
      sessionDurationMs: 1000,
      pointerSeries: [],
      keystrokes: [],
      domEvents: [],
      hasCredentialField: true,
      clientTimestamp: new Date().toISOString(),
    }, 101);
    const snapshot = tabAnalysisStore.get(101);
    assert.ok(snapshot);
    await assert.rejects(
      handleManualEscalation(101, false, {
        pageSessionId: snapshot.pageSessionId,
        navigationGeneration: snapshot.navigationGeneration,
        evaluationGeneration: snapshot.evaluationGeneration,
        telemetryId: snapshot.telemetryId,
        url: snapshot.url,
        warningVisible: snapshot.warningVisible,
        topologyScanComplete: snapshot.topologyScanComplete,
      }),
      /Cloud escalation gateway timed out/,
    );
    assert.ok(escalationSignal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('worker update handling preserves SPA sessions but retires replaced documents', async () => {
  const env = setupChromeMock();
  handleTabUpdated(101, { status: 'loading' });
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const firstPayload: InteractionTelemetryPayload = {
    telemetryId: '33333333-3333-3333-3333-333333333333',
    url: 'https://login-portal.example-auth.com/verify',
    domain: 'login-portal.example-auth.com',
    pageTitle: 'Sign In',
    sessionDurationMs: 1000,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [],
    hasCredentialField: true,
    clientTimestamp: new Date().toISOString(),
  };
  try {
    await handleTelemetryEvaluation(firstPayload, 101);
    const firstSnapshot = tabAnalysisStore.get(101);
    assert.ok(firstSnapshot);

    const spaUrl = 'https://login-portal.example-auth.com/verify/step2';
    env.setUrl(spaUrl);
    // Same-document navigations report {url, status:'loading'} together; the
    // session must survive because the same collector keeps running.
    handleTabUpdated(101, { url: spaUrl, status: 'loading' });
    await handleTelemetryEvaluation({
      ...firstPayload,
      telemetryId: '44444444-4444-4444-8444-444444444444',
      url: spaUrl,
      clientTimestamp: new Date().toISOString(),
    }, 101);
    const spaSnapshot = tabAnalysisStore.get(101);
    assert.ok(spaSnapshot);
    assert.equal(spaSnapshot.pageSessionId, firstSnapshot.pageSessionId);
    assert.equal(spaSnapshot.navigationGeneration, firstSnapshot.navigationGeneration + 1);

    // A real document replacement reports loading without a URL change.
    handleTabUpdated(101, { status: 'loading' });
    await handleTelemetryEvaluation({
      ...firstPayload,
      telemetryId: '55555555-5555-4555-8555-555555555555',
      url: spaUrl,
      clientTimestamp: new Date().toISOString(),
    }, 101);
    const reloadedSnapshot = tabAnalysisStore.get(101);
    assert.ok(reloadedSnapshot);
    assert.notEqual(reloadedSnapshot.pageSessionId, spaSnapshot.pageSessionId);

    const stalePage = {
      pageSessionId: spaSnapshot.pageSessionId,
      navigationGeneration: spaSnapshot.navigationGeneration,
      evaluationGeneration: spaSnapshot.evaluationGeneration + 1,
      url: spaUrl,
      warningVisible: false,
      topologyScanComplete: true,
    };
    const staleResult = await handleTelemetryEvaluation({
      ...firstPayload,
      telemetryId: '66666666-6666-4666-8666-666666666666',
      url: spaUrl,
      clientTimestamp: new Date().toISOString(),
    }, 101, false, stalePage);
    assert.equal(staleResult.stale, true);
    assert.equal(tabAnalysisStore.get(101)?.telemetryId, reloadedSnapshot.telemetryId);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
  }
});

test('cloud verdict clearing requires the addressed active tab snapshot', async () => {
  const { store } = setupChromeMock();
  handleTabUpdated(101, { status: 'loading' });
  const originalRecord = sqliteStorage.recordInspection.bind(sqliteStorage);
  sqliteStorage.recordInspection = async () => {};
  const globalVerdict = { telemetryId: 'global-verdict-is-not-the-tab-state' };
  store.cloudVerdict = globalVerdict;
  try {
    const payload: InteractionTelemetryPayload = {
      telemetryId: '77777777-7777-4777-8777-777777777777',
      url: 'https://login-portal.example-auth.com/verify',
      domain: 'login-portal.example-auth.com',
      pageTitle: 'Login',
      sessionDurationMs: 1000,
      pointerSeries: [],
      keystrokes: [],
      domEvents: [],
      hasCredentialField: true,
      clientTimestamp: new Date().toISOString(),
    };
    await handleTelemetryEvaluation(payload, 101);
    const snapshot = tabAnalysisStore.get(101);
    assert.ok(snapshot);
    const verdict = {
      analysisId: '11111111-1111-4111-8111-111111111111',
      telemetryId: snapshot.telemetryId,
      isPhishing: false,
      targetBrand: null,
      confidence: 0.1,
      actionOverride: 'ALLOW',
      explanationReasons: [],
      teacherModelVersion: 'cloud-evidence-v2',
      evaluatedAt: new Date().toISOString(),
    };
    assert.equal(tabAnalysisStore.attachCloudVerdict(snapshot, verdict), true);
    const reference = {
      pageSessionId: snapshot.pageSessionId,
      navigationGeneration: snapshot.navigationGeneration,
      evaluationGeneration: snapshot.evaluationGeneration,
      telemetryId: snapshot.telemetryId,
      url: snapshot.url,
      warningVisible: snapshot.warningVisible,
      topologyScanComplete: snapshot.topologyScanComplete,
    };
    assert.equal(await clearTabCloudVerdict(202, reference), false);
    assert.equal(await clearTabCloudVerdict(101, reference), true);
    assert.equal(tabAnalysisStore.get(101)?.cloudVerdict, null);
    assert.equal(store.cloudVerdict, globalVerdict);
  } finally {
    sqliteStorage.recordInspection = originalRecord;
  }
});

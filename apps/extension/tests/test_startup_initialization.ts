import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStorage } from '../src/background/model-storage.ts';
import { modelSyncManager } from '../src/background/model-sync-manager.ts';
import { sqliteStorage } from '../src/background/sqlite-storage.ts';
import { extensionUpdateManager } from '../src/background/extension-update-manager.ts';
import type { ModelSyncStatus, ClientInferenceResult, InteractionTelemetryPayload } from '@phishguard/types';
import type { ModalityBreakdown, VisionUnavailableReason } from '../src/background/types.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makePayload(url: string, telemetryId: string): InteractionTelemetryPayload {
  return {
    telemetryId,
    url,
    domain: new URL(url).hostname,
    pageTitle: 'Login',
    sessionDurationMs: 1000,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [],
    hasCredentialField: false,
    clientTimestamp: new Date().toISOString(),
  };
}

function makePrediction(
  payload: InteractionTelemetryPayload,
  runtimeAvailability?: {
    topologyScanComplete?: boolean;
    visionUnavailableReason?: VisionUnavailableReason | null;
  }
): { result: ClientInferenceResult; breakdown: ModalityBreakdown } {
  const evaluatedAt = new Date().toISOString();
  const breakdown: ModalityBreakdown = {
    interaction: {
      score: null,
      status: 'skipped',
      detail: 'Behavioral input unavailable',
      samples: payload.pointerSeries.length,
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
      explainability: {
        available: false,
        captureReason: runtimeAvailability?.visionUnavailableReason ?? null,
      },
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
        topologyScanComplete: runtimeAvailability?.topologyScanComplete ?? true,
      },
    },
  };
  return {
    result: {
      clientRiskScore: 0.05,
      routeAction: 'SAFE',
      inferenceLatencyMs: 1,
      evaluatedAt,
      modelVersion: 'v1.5.0',
    },
    breakdown,
  };
}

test('local startup gates telemetry and status independently of gateway health', async () => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const hadChrome = Object.prototype.hasOwnProperty.call(globalScope, 'chrome');
  const hadFetch = Object.prototype.hasOwnProperty.call(globalScope, 'fetch');
  const originalChrome = globalScope.chrome;
  const originalFetch = globalScope.fetch;
  const originalSqliteInit = sqliteStorage.init.bind(sqliteStorage);
  const originalRecordInspection = sqliteStorage.recordInspection.bind(sqliteStorage);
  const originalModelStatus = modelStorage.getSyncStatus.bind(modelStorage);
  const originalModelSync = modelSyncManager.syncWithBackend.bind(modelSyncManager);
  const originalSetBackendUrl = modelSyncManager.setBackendUrl.bind(modelSyncManager);
  const originalSetGatewayCapabilities = modelSyncManager.setGatewayCapabilities.bind(modelSyncManager);
  const originalExtensionCheck = extensionUpdateManager.checkForExtensionUpdate.bind(extensionUpdateManager);
  const originalExtensionSetBackendUrl = extensionUpdateManager.setBackendUrl.bind(extensionUpdateManager);
  const localGate = deferred<void>();
  const initializeStarted = deferred<void>();
  const healthStarted = deferred<void>();
  const bothHealthStarted = deferred<void>();
  const bothInjected = deferred<void>();
  const bothInitialPageChecks = deferred<void>();
  const healthResponders: Array<(response: Response) => void> = [];
  const listeners: Array<(
    message: Record<string, unknown>,
    sender: { tab?: { id?: number } },
    sendResponse: (response: unknown) => void
  ) => unknown> = [];
  const identityByTab = new Map<number, Record<string, unknown>>();
  const initialPageChecks = new Set<number>();
  const tabUrlById = new Map<number, string>();
  const sessionData: Record<string, unknown> = {};
  const injectedTabIds: number[] = [];
  const predictedUrls: string[] = [];
  let healthCalls = 0;
  let syncCalls = 0;
  let engineReady = false;
  let persistedStatus: ModelSyncStatus = {
    currentVersion: '0.0.0',
    latestAvailableVersion: '0.0.0',
    isLatest: false,
    lastSyncAttempt: new Date().toISOString(),
    syncState: 'ONLINE_SYNCED',
    backendReachable: true,
    modelSource: 'LOCAL_BUNDLED',
    activeMetadata: null,
  };
  const syncStatus = (): ModelSyncStatus => ({
    ...persistedStatus,
    currentVersion: '0.0.0',
    latestAvailableVersion: '0.0.0',
  });
  const url1 = 'https://startup.example/login';
  const url2 = 'https://navigation.example/login';
  tabUrlById.set(1, url1);
  tabUrlById.set(2, url2);
  const envelope1 = {
    pageSessionId: 'startup-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: url1,
    warningVisible: false,
    topologyScanComplete: true,
  };
  const envelope2 = {
    pageSessionId: 'navigation-session',
    navigationGeneration: 0,
    evaluationGeneration: 1,
    url: url2,
    warningVisible: false,
    topologyScanComplete: true,
  };
  identityByTab.set(1, { ...envelope1 });
  identityByTab.set(2, { ...envelope2 });
  const chromeMock = {
    storage: {
      local: {
        get: async () => ({ backendUrl: 'http://gateway.test.invalid' }),
        set: async () => {},
        remove: async () => {},
      },
      session: {
        get: async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          const result: Record<string, unknown> = {};
          for (const key of list) if (key in sessionData) result[key] = sessionData[key];
          return result;
        },
        set: async (items: Record<string, unknown>) => Object.assign(sessionData, items),
        remove: async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          for (const key of list) delete sessionData[key];
        },
      },
    },
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(listener: (
          message: Record<string, unknown>,
          sender: { tab?: { id?: number } },
          sendResponse: (response: unknown) => void
        ) => unknown) {
          listeners.push(listener);
        },
      },
      sendMessage: (_message: unknown, callback?: (response?: unknown) => void) => callback?.({ success: true }),
    },
    tabs: {
      get: async (tabId: number) => ({ id: tabId, url: tabUrlById.get(tabId), active: true }),
      query: async () => [{ id: 1, url: url1 }, { id: 2, url: url2 }],
      sendMessage: (
        tabId: number,
        message: { type?: string },
        callback?: (response?: unknown) => void
      ) => {
        if (message.type === 'GET_PAGE_IDENTITY') {
          callback?.(identityByTab.get(tabId));
          if (!initialPageChecks.has(tabId)) {
            initialPageChecks.add(tabId);
            if (initialPageChecks.size === 2) bothInitialPageChecks.resolve(undefined);
          }
        } else {
          callback?.({ success: true });
        }
      },
    },
    scripting: {
    executeScript: async (details: { target: { tabId: number } }) => {
        injectedTabIds.push(details.target.tabId);
        if (injectedTabIds.length === 2) bothInjected.resolve(undefined);
        return [];
      },
    },
  };
  globalScope.chrome = chromeMock;
  globalScope.fetch = async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/health')) throw new Error('Unexpected network request');
    healthCalls++;
    healthStarted.resolve(undefined);
    if (healthCalls === 2) bothHealthStarted.resolve(undefined);
    return new Promise<Response>((resolve) => healthResponders.push(resolve));
  };
  sqliteStorage.init = async () => {};
  sqliteStorage.recordInspection = async () => {};
  modelStorage.getSyncStatus = async () => persistedStatus;
  modelSyncManager.setBackendUrl = () => {};
  modelSyncManager.setGatewayCapabilities = () => {};
  modelSyncManager.syncWithBackend = async () => {
    syncCalls++;
    return syncStatus();
  };
  extensionUpdateManager.setBackendUrl = () => {};
  extensionUpdateManager.checkForExtensionUpdate = (async () => ({
    currentVersion: '0.5.0',
    latestVersion: '0.5.0',
    updateAvailable: false,
  })) as unknown as typeof extensionUpdateManager.checkForExtensionUpdate;

  let worker: typeof import('../src/background/service-worker.ts');
  let restoreWorkerEngine: (() => void) | undefined;
  try {
    worker = await import('../src/background/service-worker.ts');
    const originalInitialize = worker.engine.initialize.bind(worker.engine);
    const originalIsReady = worker.engine.isReady.bind(worker.engine);
    const originalPredictDetailed = worker.engine.predictDetailed.bind(worker.engine);
    restoreWorkerEngine = () => {
      worker.engine.initialize = originalInitialize;
      worker.engine.isReady = originalIsReady;
      worker.engine.predictDetailed = originalPredictDetailed;
    };
    worker.engine.initialize = async () => {
      initializeStarted.resolve(undefined);
      await localGate.promise;
      engineReady = true;
    };
    worker.engine.isReady = () => engineReady;
    worker.engine.predictDetailed = async (payload, _visual, runtimeAvailability) => {
      predictedUrls.push(payload.url);
      return makePrediction(payload, runtimeAvailability);
    };

    (chromeMock.runtime as unknown as { id?: string }).id = 'startup-test';
    worker.initializeSystem();
    await initializeStarted.promise;

    const sendRuntimeMessage = (
      message: Record<string, unknown>,
      sender: { tab?: { id?: number } } = {}
    ) => new Promise<unknown>((resolve) => {
      assert.equal(listeners.length > 0, true);
      listeners[0](message, sender, resolve);
    });
    const statusWhileLoading = await sendRuntimeMessage({ type: 'GET_MODEL_STATUS' }) as {
      runtimeState: string;
    };
    assert.equal(statusWhileLoading.runtimeState, 'loading');

    const checkUpdatePromise = sendRuntimeMessage({ type: 'CHECK_MODEL_UPDATE' });
    const evaluation1 = sendRuntimeMessage(
      { type: 'EVALUATE_TELEMETRY', payload: makePayload(url1, '11111111-1111-4111-8111-111111111111'), ...envelope1 },
      { tab: { id: 1 } }
    );
    const evaluation2 = sendRuntimeMessage(
      { type: 'EVALUATE_TELEMETRY', payload: makePayload(url2, '22222222-2222-4222-8222-222222222222'), ...envelope2 },
      { tab: { id: 2 } }
    );
    await bothInitialPageChecks.promise;
    assert.equal(predictedUrls.length, 0);
    assert.equal(healthCalls, 0);
    assert.equal(syncCalls, 0);

    identityByTab.set(2, {
      ...envelope2,
      pageSessionId: 'navigation-session-new',
      navigationGeneration: 1,
      url: 'https://navigation.example/next',
    });
    tabUrlById.set(2, 'https://navigation.example/next');
    localGate.resolve(undefined);

    const [result1, result2] = await Promise.all([evaluation1, evaluation2]) as [
      { success: boolean; result: { url: string } },
      { success: boolean; result: { stale?: boolean } }
    ];
    assert.equal(result1.success, true);
    assert.equal(result1.result.url, url1);
    assert.equal(result2.success, true);
    assert.equal(result2.result.stale, true);
    assert.deepEqual(predictedUrls, [url1]);

    await healthStarted.promise;
    await bothHealthStarted.promise;
    assert.equal(healthCalls, 2);
    assert.equal(syncCalls, 0);
    await bothInjected.promise;
    assert.deepEqual(injectedTabIds.sort(), [1, 2]);

    const offlineStatus: ModelSyncStatus = {
      ...persistedStatus,
      currentVersion: '0.0.0',
      latestAvailableVersion: '0.0.0',
      syncState: 'OFFLINE_FALLBACK',
      backendReachable: false,
    };
    persistedStatus = offlineStatus;
    const readyOffline = await sendRuntimeMessage({ type: 'GET_MODEL_STATUS' }) as {
      runtimeState: string;
      status: ModelSyncStatus;
    };
    assert.equal(readyOffline.runtimeState, 'ready');
    assert.equal(readyOffline.status.syncState, 'OFFLINE_FALLBACK');

    persistedStatus = { ...offlineStatus, syncState: 'ONLINE_SYNCED', backendReachable: true };
    engineReady = false;
    const staleCachedReady = await sendRuntimeMessage({ type: 'GET_MODEL_STATUS' }) as {
      runtimeState: string;
      status: ModelSyncStatus;
    };
    assert.equal(staleCachedReady.runtimeState, 'unavailable');
    assert.equal(staleCachedReady.status.syncState, 'OFFLINE_FALLBACK');

    for (const respond of healthResponders) respond({ ok: false } as Response);
    await checkUpdatePromise;
    assert.equal(syncCalls, 2);
  } finally {
    restoreWorkerEngine?.();
    sqliteStorage.init = originalSqliteInit;
    sqliteStorage.recordInspection = originalRecordInspection;
    modelStorage.getSyncStatus = originalModelStatus;
    modelSyncManager.syncWithBackend = originalModelSync;
    modelSyncManager.setBackendUrl = originalSetBackendUrl;
    modelSyncManager.setGatewayCapabilities = originalSetGatewayCapabilities;
    extensionUpdateManager.checkForExtensionUpdate = originalExtensionCheck;
    extensionUpdateManager.setBackendUrl = originalExtensionSetBackendUrl;
    if (hadChrome) globalScope.chrome = originalChrome;
    else delete globalScope.chrome;
    if (hadFetch) globalScope.fetch = originalFetch;
    else delete globalScope.fetch;
  }
});

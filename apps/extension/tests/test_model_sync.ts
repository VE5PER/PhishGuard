import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBufferSha256, ModelSyncManager } from '../src/background/model-sync-manager.ts';
import { modelStorage, ModelStorage } from '../src/background/model-storage.ts';
import { BUNDLED_BASELINE_METADATA, OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import { sqliteStorage } from '../src/background/sqlite-storage.ts';
import type { ModelMetadata, ModelSyncStatus } from '@phishguard/types';

test('computeBufferSha256 computes accurate cryptographic hashes', async () => {
  // Empty buffer SHA-256 is standard e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  const emptyBuf = new ArrayBuffer(0);
  const emptyHash = await computeBufferSha256(emptyBuf);
  assert.equal(emptyHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // Known string: "PhishGuard-2026"
  const encoder = new TextEncoder();
  const textBuf = encoder.encode('PhishGuard-2026').buffer;
  const hash = await computeBufferSha256(textBuf);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
});

test('ModelStorage stores and retrieves model records and sync status', async () => {
  const storage = new ModelStorage();
  const dummyBuffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  const dummyHash = await computeBufferSha256(dummyBuffer);
  const dummyMeta: ModelMetadata = {
    version: '1.2.0',
    name: 'phishguard-test',
    architecture: '1D-CNN + BiLSTM',
    sha256: dummyHash,
    fileSizeBytes: 5,
    releasedAt: new Date().toISOString(),
    minExtensionVersion: '0.1.0',
    features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
    metrics: {
      accuracy: 0.98,
      f1Score: 0.97,
      latencyMs: 12.0,
      memoryBudgetMb: 30.0,
    },
    changelog: ['Test changelog'],
    downloadUrl: '/v1/models/1.2.0/download',
  };

  await storage.saveModel('1.2.0', dummyBuffer, dummyMeta);
  const retrieved = await storage.getModel('1.2.0');
  assert.ok(retrieved);
  assert.equal(retrieved.version, '1.2.0');
  assert.equal(retrieved.metadata.name, 'phishguard-test');

  const list = await storage.listStoredVersions();
  assert.equal(list.length, 1);
  assert.equal(list[0].version, '1.2.0');

  // Test sync status
  await storage.saveSyncStatus({
    currentVersion: '1.2.0',
    latestAvailableVersion: '1.2.0',
    isLatest: true,
    lastSyncAttempt: new Date().toISOString(),
    syncState: 'ONLINE_SYNCED',
    backendReachable: true,
    modelSource: 'REMOTE_SYNCED',
    activeMetadata: dummyMeta,
  });

  const syncStatus = await storage.getSyncStatus();
  assert.ok(syncStatus);
  assert.equal(syncStatus.currentVersion, '1.2.0');
  assert.equal(syncStatus.syncState, 'ONLINE_SYNCED');
});

test('ModelSyncManager detects hash corruption and prevents loading', async () => {
  const manager = new ModelSyncManager('http://mock-backend:8000');

  // Mock global fetch to return corrupted payload
  const originalFetch = globalThis.fetch;
  const sampleData = new Uint8Array([10, 20, 30, 40]);

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/download')) {
        return new Response(sampleData.buffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const bogusMeta: ModelMetadata = {
      version: '1.1.0',
      name: 'corrupted-model',
      architecture: 'CNN',
      sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      fileSizeBytes: 4,
      releasedAt: new Date().toISOString(),
      minExtensionVersion: '0.1.0',
      features: ['x'],
      metrics: { accuracy: 0.9, f1Score: 0.9, latencyMs: 10, memoryBudgetMb: 10 },
      changelog: [],
      downloadUrl: '/v1/models/1.1.0/download',
    };

    await assert.rejects(
      async () => {
        await manager.downloadAndVerifyModel('1.1.0', bogusMeta);
      },
      {
        name: 'Error',
        message: /Cryptographic integrity violation/,
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ModelSyncManager reports no loaded model honestly when backend is unavailable', async () => {
  const manager = new ModelSyncManager('http://invalid-unreachable-host:9999');
  const engine = new OnDeviceStudentEngine();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('isolated offline fixture');
  };
  let syncStatus: ModelSyncStatus;
  try {
    syncStatus = await manager.syncWithBackend(engine);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(syncStatus.backendReachable, false);
  assert.equal(syncStatus.syncState, 'OFFLINE_FALLBACK');
  assert.equal(syncStatus.currentVersion, '0.0.0');
  assert.equal(syncStatus.isLatest, false);
});

test('ModelSyncManager never downgrades a working v2 session to a legacy registry response', async () => {
  const manager = new ModelSyncManager('http://offline-test.invalid');
  const engine = new OnDeviceStudentEngine();
  const activeMetadata: ModelMetadata = {
    ...BUNDLED_BASELINE_METADATA,
    version: '2.0.0-test',
    sha256: 'b'.repeat(64),
  };
  const engineState = engine as unknown as {
    session: unknown;
    isLoaded: boolean;
    activeVersion: string;
    activeMetadata: ModelMetadata;
  };
  engineState.session = { inputNames: ['trajectory', 'visual', 'page_context'] };
  engineState.isLoaded = true;
  engineState.activeVersion = activeMetadata.version;
  engineState.activeMetadata = activeMetadata;
  let swaps = 0;
  engine.hotSwapModel = async () => {
    swaps++;
    return true;
  };
  const originalFetch = globalThis.fetch;
  const originalSaveSqlite = sqliteStorage.saveSyncStatus;
  const originalSaveIndexedDb = modelStorage.saveSyncStatus;
  sqliteStorage.saveSyncStatus = async () => {};
  modelStorage.saveSyncStatus = async () => {};
  globalThis.fetch = async () => new Response(JSON.stringify({
    updateAvailable: true,
    currentVersion: activeMetadata.version,
    latestMetadata: BUNDLED_BASELINE_METADATA,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const status = await manager.syncWithBackend(engine);
    assert.equal(swaps, 0);
    assert.equal(status.currentVersion, activeMetadata.version);
    assert.equal(status.activeMetadata?.sha256, activeMetadata.sha256);
    assert.equal(status.isLatest, false);
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.saveSyncStatus = originalSaveSqlite;
    modelStorage.saveSyncStatus = originalSaveIndexedDb;
  }
});

test('ModelSyncManager checks for update based on current local version', async () => {
  const manager = new ModelSyncManager('http://mock-backend:8000');
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/check-update')) {
        const body = JSON.parse(String(init?.body || '{}'));
        const isNewer = body.currentVersion !== '1.2.0';
        return new Response(
          JSON.stringify({
            updateAvailable: isNewer,
            currentVersion: body.currentVersion,
            latestMetadata: {
              version: '1.2.0',
              name: 'phishguard-student-rustfs-dummy',
              architecture: '1D-CNN + BiLSTM',
              sha256: 'f54f9e1431c8b412ee46724eb3f04f075ee9a031ebf261c90818806988c2cbc7',
              fileSizeBytes: 107168,
              releasedAt: new Date().toISOString(),
              minExtensionVersion: '0.1.0',
              features: ['x', 'y'],
              metrics: { accuracy: 0.988, f1Score: 0.984, latencyMs: 12.2, memoryBudgetMb: 31.0 },
              changelog: ['RustFS dummy model update'],
              downloadUrl: '/v1/models/1.2.0/download',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    // When local version is 1.0.0, update should be available
    const updateCheck1 = await manager.checkForUpdate('1.0.0');
    assert.equal(updateCheck1.updateAvailable, true);
    assert.equal(updateCheck1.latestMetadata.version, '1.2.0');

    // When local version is 1.2.0, update should NOT be available
    const updateCheck2 = await manager.checkForUpdate('1.2.0');
    assert.equal(updateCheck2.updateAvailable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model sync advertises extension contracts only after gateway negotiation', async () => {
  const manager = new ModelSyncManager('http://offline-test.invalid');
  const originalFetch = globalThis.fetch;
  const globalScope = globalThis as unknown as {
    chrome?: { runtime?: { getManifest: () => { version: string } } };
  };
  const originalChrome = globalScope.chrome;
  const bodies: Array<Record<string, unknown>> = [];
  globalScope.chrome = { runtime: { getManifest: () => ({ version: '0.4.13' }) } };
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      updateAvailable: false,
      currentVersion: '1.5.0',
      latestMetadata: {
        version: '1.5.0',
        name: 'legacy',
        architecture: 'legacy',
        sha256: 'a'.repeat(64),
        fileSizeBytes: 1,
        releasedAt: new Date().toISOString(),
        minExtensionVersion: '0.1.0',
        features: ['x'],
        metrics: { accuracy: 0.9, f1Score: 0.9, latencyMs: 1, memoryBudgetMb: 1 },
        changelog: [],
        downloadUrl: '/model',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await manager.checkUpdate('1.5.0');
    assert.equal('extensionVersion' in bodies[0], false);
    assert.equal('supportedInputContracts' in bodies[0], false);
    manager.setGatewayCapabilities({
      telemetryEvidenceVersion: 2,
      modelInputContracts: ['student-v1', 'student-v2'],
      manualEscalation: true,
    });
    await manager.checkUpdate('1.5.0');
    assert.equal(bodies[1].extensionVersion, '0.4.13');
    assert.deepEqual(bodies[1].supportedInputContracts, ['student-v1', 'student-v2']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete globalScope.chrome;
    else globalScope.chrome = originalChrome;
  }
});

test('ModelSyncManager repairs a same-version hash only after successful activation', async () => {
  const manager = new ModelSyncManager('http://offline-test.invalid');
  const engine = new OnDeviceStudentEngine();
  const originalMetadata = {
    ...BUNDLED_BASELINE_METADATA,
    version: '1.5.0',
  };
  const engineState = engine as unknown as {
    session: unknown;
    isLoaded: boolean;
    activeVersion: string;
    activeMetadata: ModelMetadata;
    activeSource: 'REMOTE_SYNCED' | 'LOCAL_BUNDLED' | 'CACHE_STORAGE';
  };
  engineState.session = { inputNames: ['trajectory', 'visual'] };
  engineState.isLoaded = true;
  engineState.activeVersion = originalMetadata.version;
  engineState.activeMetadata = originalMetadata;
  const modelBytes = new Uint8Array([9, 8, 7, 6]).buffer;
  const repairedHash = await computeBufferSha256(modelBytes);
  const repairedMetadata: ModelMetadata = {
    ...originalMetadata,
    sha256: repairedHash,
    fileSizeBytes: modelBytes.byteLength,
  };
  const operations: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalSqliteSaveModel = sqliteStorage.saveModel;
  const originalModelSaveModel = modelStorage.saveModel;
  const originalSqliteSaveStatus = sqliteStorage.saveSyncStatus;
  const originalModelSaveStatus = modelStorage.saveSyncStatus;
  engine.hotSwapModel = async (_buffer, metadata) => {
    operations.push('activate');
    engineState.activeMetadata = metadata;
    engineState.activeVersion = metadata.version;
    return true;
  };
  sqliteStorage.saveModel = async () => {
    operations.push('sqlite');
  };
  modelStorage.saveModel = async () => {
    operations.push('indexeddb');
  };
  sqliteStorage.saveSyncStatus = async () => {};
  modelStorage.saveSyncStatus = async () => {};
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (String(input).includes('/check-update')) {
      return new Response(JSON.stringify({
        updateAvailable: true,
        currentVersion: '1.5.0',
        latestMetadata: repairedMetadata,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(modelBytes, { status: 200 });
  };
  try {
    const result = await manager.downloadAndStoreLatestModel(engine);
    assert.equal(result.updated, true);
    assert.equal(result.status.currentVersion, '1.5.0');
    assert.equal(result.metadata?.sha256, repairedHash);
    assert.deepEqual(operations, ['activate', 'sqlite', 'indexeddb']);
  } finally {
    globalThis.fetch = originalFetch;
    sqliteStorage.saveModel = originalSqliteSaveModel;
    modelStorage.saveModel = originalModelSaveModel;
    sqliteStorage.saveSyncStatus = originalSqliteSaveStatus;
    modelStorage.saveSyncStatus = originalModelSaveStatus;
  }
});

test('ModelSyncManager downloads latest model and stores into extension storage for inference', async () => {
  const manager = new ModelSyncManager('http://mock-backend:8000');
  const engine = new OnDeviceStudentEngine();
  const originalFetch = globalThis.fetch;

  // Real valid sample buffer and its true SHA-256
  const sampleData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const sampleHash = await computeBufferSha256(sampleData.buffer);

  // Mock engine.hotSwapModel so test runs cleanly without browser WASM web workers
  let hotSwappedVersion = '';
  const engineState = engine as unknown as {
    activeVersion: string;
    activeMetadata: ModelMetadata | null;
    activeSource: 'REMOTE_SYNCED' | 'LOCAL_BUNDLED' | 'CACHE_STORAGE';
    isLoaded: boolean;
  };
  engine.hotSwapModel = async (_buf: ArrayBuffer, meta: ModelMetadata) => {
    hotSwappedVersion = meta.version;
    engineState.activeVersion = meta.version;
    engineState.activeMetadata = meta;
    engineState.activeSource = 'REMOTE_SYNCED';
    engineState.isLoaded = true;
    return true;
  };

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/check-update')) {
        return new Response(
          JSON.stringify({
            updateAvailable: true,
            currentVersion: '1.0.0',
            latestMetadata: {
              version: '1.2.0',
              name: 'phishguard-student-rustfs-dummy',
              architecture: '1D-CNN + BiLSTM',
              sha256: sampleHash,
              fileSizeBytes: sampleData.byteLength,
              releasedAt: new Date().toISOString(),
              minExtensionVersion: '0.1.0',
              features: ['x', 'y'],
              metrics: { accuracy: 0.988, f1Score: 0.984, latencyMs: 12.2, memoryBudgetMb: 31.0 },
              changelog: ['RustFS dummy model update'],
              downloadUrl: '/v1/models/1.2.0/download',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/download')) {
        return new Response(sampleData.buffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Storage-Backend': 'rustfs',
          },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await manager.downloadAndStoreLatestModel(engine);
    assert.equal(result.updated, true);
    assert.equal(result.status.currentVersion, '1.2.0');
    assert.equal(result.status.modelSource, 'REMOTE_SYNCED');
    assert.equal(hotSwappedVersion, '1.2.0');

    // Verify persisted in ModelStorage
    const stored = await modelStorage.getModel('1.2.0');
    assert.ok(stored);
    assert.equal(stored.version, '1.2.0');
    assert.equal(stored.metadata.sha256, sampleHash);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

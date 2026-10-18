import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteFrontendStorage } from '../src/background/sqlite-storage.ts';
import type { ModelMetadata } from '@phishguard/types';

test('SQLiteFrontendStorage initializes and executes SQLite DDL', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();
  assert.equal(storage.isReady(), true);
});

test('SQLiteFrontendStorage persists and retrieves model binaries as BLOBs', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();

  const dummyData = new Uint8Array([100, 101, 102, 103, 104]);
  const sha256 = createHash('sha256').update(dummyData).digest('hex');
  const metadata: ModelMetadata = {
    version: '1.3.0',
    name: 'phishguard-sqlite-model',
    architecture: '1D-CNN + BiLSTM (WASM)',
    sha256,
    fileSizeBytes: 5,
    releasedAt: new Date().toISOString(),
    minExtensionVersion: '0.1.0',
    features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
    metrics: {
      accuracy: 0.985,
      f1Score: 0.98,
      latencyMs: 10.5,
      memoryBudgetMb: 25.0,
    },
    changelog: ['Stored in frontend SQLite WASM DB'],
    downloadUrl: '/v1/models/1.3.0/download',
    inputContract: {
      identifier: 'student-v1',
      trajectoryPreprocessing: 'legacy-trajectory',
      inputs: [{ name: 'trajectory', dtype: 'float32', shape: [128, 6] }],
      contextFeatures: [],
    },
  };

  await storage.saveModel('1.3.0', dummyData.buffer, metadata);

  const retrieved = await storage.getModel('1.3.0');
  assert.ok(retrieved);
  assert.equal(retrieved.version, '1.3.0');
  assert.equal(retrieved.metadata.name, 'phishguard-sqlite-model');
  assert.equal(retrieved.metadata.metrics.accuracy, 0.985);
  assert.equal(retrieved.metadata.inputContract?.identifier, 'student-v1');

  const retUint8 = new Uint8Array(retrieved.buffer);
  assert.equal(retUint8.length, 5);
  assert.equal(retUint8[0], 100);
  assert.equal(retUint8[4], 104);

  // Test getLatestStoredModel
  const latest = await storage.getLatestStoredModel();
  assert.ok(latest);
  assert.equal(latest.version, '1.3.0');
});

test('SQLiteFrontendStorage records and queries inspection history', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();

  await storage.recordInspection({
    url: 'https://suspicious-test-login.com',
    domain: 'suspicious-test-login.com',
    riskScore: 0.92,
    action: 'BLOCK',
    modelVersion: 'v1.1.0',
    pointerSamples: 45,
    keystrokeSamples: 12,
    domAnomalies: 2,
    timestamp: new Date().toISOString(),
  });

  const history = await storage.getRecentInspections(5);
  assert.ok(history.length >= 1);
  const item = history[0];
  assert.equal(item.domain, 'suspicious-test-login.com');
  assert.equal(item.action, 'BLOCK');
  assert.equal(item.riskScore, 0.92);
});

test('SQLiteFrontendStorage manages sync state in SQLite key-value table', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();

  await storage.saveSyncStatus({
    currentVersion: '1.1.0',
    latestAvailableVersion: '1.1.0',
    isLatest: true,
    lastSyncAttempt: new Date().toISOString(),
    syncState: 'ONLINE_SYNCED',
    backendReachable: true,
    modelSource: 'REMOTE_SYNCED',
  });

  const status = await storage.getSyncStatus();
  assert.ok(status);
  assert.equal(status.currentVersion, '1.1.0');
  assert.equal(status.syncState, 'ONLINE_SYNCED');
});

function record(domain: string) {
  return {
    url: `https://${domain}`,
    domain,
    riskScore: 0.5,
    action: 'AMBIGUOUS',
    modelVersion: 'v1.5.0',
    pointerSamples: 1,
    keystrokeSamples: 0,
    domAnomalies: 0,
    timestamp: new Date().toISOString(),
  };
}

test('inspection writes coalesce into one export per batch window', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();
  const internals = storage as unknown as {
    writeBinaryToIndexedDB: (buffer: ArrayBuffer) => Promise<void>;
  };
  const original = internals.writeBinaryToIndexedDB.bind(storage);
  let writes = 0;
  internals.writeBinaryToIndexedDB = async (buffer) => {
    writes++;
    return original(buffer);
  };
  try {
    await Promise.all([
      storage.recordInspection(record('a.example')),
      storage.recordInspection(record('b.example')),
      storage.recordInspection(record('c.example')),
    ]);
    assert.equal(writes, 1);
  } finally {
    internals.writeBinaryToIndexedDB = original;
  }
});

test('a mutation arriving during an export triggers a follow-up export', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();
  const internals = storage as unknown as {
    writeBinaryToIndexedDB: (buffer: ArrayBuffer) => Promise<void>;
  };
  const original = internals.writeBinaryToIndexedDB.bind(storage);
  let writes = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const firstWriteStarted = new Promise<void>((resolve) => {
    internals.writeBinaryToIndexedDB = async (buffer) => {
      writes++;
      if (writes === 1) {
        resolve();
        await firstWriteGate;
      }
      return original(buffer);
    };
  });
  try {
    const first = storage.recordInspection(record('first.example'));
    await firstWriteStarted;
    const second = storage.recordInspection(record('second.example'));
    releaseFirstWrite();
    await Promise.all([first, second]);
    assert.equal(writes, 2);
  } finally {
    internals.writeBinaryToIndexedDB = original;
    releaseFirstWrite();
  }
});

test('model and sync-state writes flush immediately without waiting for the batch window', async () => {
  const storage = new SQLiteFrontendStorage();
  await storage.init();
  const internals = storage as unknown as {
    writeBinaryToIndexedDB: (buffer: ArrayBuffer) => Promise<void>;
  };
  const original = internals.writeBinaryToIndexedDB.bind(storage);
  let writes = 0;
  internals.writeBinaryToIndexedDB = async (buffer) => {
    writes++;
    return original(buffer);
  };
  try {
    const startedAt = Date.now();
    await storage.saveSyncStatus({
      currentVersion: '1.1.0',
      latestAvailableVersion: '1.1.0',
      isLatest: true,
      lastSyncAttempt: new Date().toISOString(),
      syncState: 'ONLINE_SYNCED',
      backendReachable: true,
      modelSource: 'REMOTE_SYNCED',
    });
    assert.equal(writes, 1);
    assert.ok(Date.now() - startedAt < 250, 'sync-state write must not wait for the batch window');
  } finally {
    internals.writeBinaryToIndexedDB = original;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelStorage } from '../src/background/model-storage.ts';
import type { ModelMetadata } from '@phishguard/types';

interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function makeRequest(compute: () => unknown): FakeRequest {
  const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      request.result = compute();
    } catch (error) {
      request.error = error;
      request.onerror?.();
      return;
    }
    request.onsuccess?.();
  });
  return request;
}

function installFakeIndexedDB() {
  const globalScope = globalThis as unknown as { indexedDB?: unknown };
  const original = globalScope.indexedDB;
  const stores = new Map<string, Map<unknown, unknown>>();
  let openCalls = 0;

  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        objectStore(name: string) {
          if (!stores.has(name)) stores.set(name, new Map());
          const data = stores.get(name)!;
          return {
            get: (key: unknown) => makeRequest(() => data.get(key)),
            getAllKeys: () => makeRequest(() => [...data.keys()]),
            getAll: () => makeRequest(() => [...data.values()]),
            put: (record: { version?: string; key?: string }) =>
              makeRequest(() => {
                data.set(record.version ?? record.key, record);
                return undefined;
              }),
          };
        },
      };
      // Fire oncomplete after all queued request microtasks have run.
      queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
      return tx;
    },
  };

  globalScope.indexedDB = {
    open: () => {
      openCalls++;
      const request: FakeRequest = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      } as FakeRequest;
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  return {
    stores,
    getOpenCalls: () => openCalls,
    restore() {
      if (original === undefined) delete globalScope.indexedDB;
      else globalScope.indexedDB = original;
    },
  };
}

function modelMetadata(version: string, buffer: ArrayBuffer): ModelMetadata {
  return {
    version,
    name: 'phishguard-idb-model',
    architecture: '1D-CNN + BiLSTM (WASM)',
    sha256: createHash('sha256').update(new Uint8Array(buffer)).digest('hex'),
    fileSizeBytes: buffer.byteLength,
    releasedAt: new Date().toISOString(),
    minExtensionVersion: '0.1.0',
    features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
    metrics: { accuracy: 0.98, f1Score: 0.98, latencyMs: 1, memoryBudgetMb: 20 },
    changelog: [],
    downloadUrl: `/v1/models/${version}/download`,
    inputContract: {
      identifier: 'student-v1',
      trajectoryPreprocessing: 'legacy-trajectory',
      inputs: [{ name: 'trajectory', dtype: 'float32', shape: [128, 6] }],
      contextFeatures: [],
    },
  };
}

test('ModelStorage reuses one managed IndexedDB connection and resolves on transaction complete', async () => {
  const idb = installFakeIndexedDB();
  try {
    const storage = new ModelStorage();
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    await storage.saveModel('1.2.0', buffer, modelMetadata('1.2.0', buffer));
    const record = await storage.getModel('1.2.0');
    assert.ok(record);
    assert.equal(record.version, '1.2.0');
    const keys = await storage.listStoredVersionKeys();
    assert.deepEqual(keys, ['1.2.0']);
    // One managed connection across all operations — no per-call reopen.
    assert.equal(idb.getOpenCalls(), 1);
  } finally {
    idb.restore();
  }
});

test('listStoredVersionKeys returns semver-descending keys without reading binaries', async () => {
  const idb = installFakeIndexedDB();
  try {
    const storage = new ModelStorage();
    for (const version of ['1.2.0', '1.10.0', '1.3.0']) {
      const buffer = new Uint8Array([version.length]).buffer;
      await storage.saveModel(version, buffer, modelMetadata(version, buffer));
    }
    const keys = await storage.listStoredVersionKeys();
    assert.deepEqual(keys, ['1.10.0', '1.3.0', '1.2.0']);
  } finally {
    idb.restore();
  }
});

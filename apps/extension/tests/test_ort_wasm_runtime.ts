import test from 'node:test';
import assert from 'node:assert/strict';
import * as ort from 'onnxruntime-web/wasm';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import { sqliteStorage } from '../src/background/sqlite-storage.ts';
import { modelStorage } from '../src/background/model-storage.ts';

const WASM_ASSET_URL = 'chrome-extension://test/dist/assets/ort-wasm-simd-threaded.wasm';
const WASM_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
// The exact ArrayBuffer the fetch resolves; identity assertions prove the
// engine assigns it to env.wasm.wasmBinary directly without slice() or a
// module-level cached copy.
const FETCHED_WASM_BINARY = WASM_BYTES.slice(0);

function installChromeAndFetch() {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {
    chrome: globalScope.chrome,
    fetch: globalScope.fetch,
  };
  const wasmFetches: string[] = [];
  const fetchedUrls: string[] = [];
  globalScope.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '0.5.1' }),
    },
  };
  globalScope.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === WASM_ASSET_URL) {
      wasmFetches.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => FETCHED_WASM_BINARY } as Response;
    }
    // Model sidecars: pretend none exist so the bundled metadata constant is used.
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
  };
  return {
    wasmFetches,
    fetchedUrls,
    restore() {
      if (original.chrome === undefined) delete globalScope.chrome;
      else globalScope.chrome = original.chrome;
      if (original.fetch === undefined) delete globalScope.fetch;
      else globalScope.fetch = original.fetch;
    },
  };
}

test('ORT WASM config uses object wasmPaths, prefetched wasmBinary, and stays single-flight', async () => {
  const env = installChromeAndFetch();
  const originalListSqlite = sqliteStorage.listStoredModelVersions.bind(sqliteStorage);
  const originalListIdb = modelStorage.listStoredVersionKeys.bind(modelStorage);
  sqliteStorage.listStoredModelVersions = async () => [];
  modelStorage.listStoredVersionKeys = async () => [];
  try {
    const engine = new OnDeviceStudentEngine();
    // Avoid real session construction; config happens before activation.
    engine.hotSwapModel = async () => true;

    await engine.initialize();

    assert.equal(ort.env.wasm.numThreads, 1);
    const paths = ort.env.wasm.wasmPaths as unknown;
    // MV3 service workers cannot dynamic-import(): wasmPaths must never be a
    // string prefix or point at an .mjs worker/proxy module.
    assert.notEqual(typeof paths, 'string');
    assert.ok(paths && typeof paths === 'object');
    const wasmEntry = (paths as Record<string, unknown>).wasm;
    assert.equal(typeof wasmEntry, 'string');
    assert.ok(String(wasmEntry).endsWith('.wasm'));
    assert.ok(!String(wasmEntry).includes('.mjs'));
    for (const value of Object.values(paths as Record<string, unknown>)) {
      assert.ok(!String(value).includes('.mjs'));
    }
    assert.ok(ort.env.wasm.wasmBinary instanceof ArrayBuffer);
    assert.equal((ort.env.wasm.wasmBinary as ArrayBuffer).byteLength, WASM_BYTES.byteLength);
    // The fetched buffer is assigned directly — no cached copy, no slice().
    assert.equal(ort.env.wasm.wasmBinary, FETCHED_WASM_BINARY);
    assert.deepEqual(env.wasmFetches, [WASM_ASSET_URL]);

    // Single-flight: a second initialize must not re-fetch or re-assign.
    const engine2 = new OnDeviceStudentEngine();
    engine2.hotSwapModel = async () => true;
    await engine2.initialize();
    assert.deepEqual(env.wasmFetches, [WASM_ASSET_URL]);
    assert.equal(ort.env.wasm.wasmBinary, FETCHED_WASM_BINARY);
    // No fetch may have targeted an .mjs module at any point.
    assert.ok(env.fetchedUrls.every((url) => !url.includes('.mjs')));
  } finally {
    sqliteStorage.listStoredModelVersions = originalListSqlite;
    modelStorage.listStoredVersionKeys = originalListIdb;
    env.restore();
  }
});

test('engine initializes lazily: version keys only, one binary at a time in descending order', async () => {
  const env = installChromeAndFetch();
  const storage = {
    sqliteList: sqliteStorage.listStoredModelVersions.bind(sqliteStorage),
    sqliteGet: sqliteStorage.getModel.bind(sqliteStorage),
    idbList: modelStorage.listStoredVersionKeys.bind(modelStorage),
    idbGet: modelStorage.getModel.bind(modelStorage),
  };
  const getOrder: string[] = [];
  sqliteStorage.listStoredModelVersions = async () => ['2.0.0', '1.9.0'];
  sqliteStorage.getModel = async (version: string) => {
    getOrder.push(`sqlite:${version}`);
    return null; // corrupt/empty cache entry
  };
  modelStorage.listStoredVersionKeys = async () => ['3.0.0'];
  modelStorage.getModel = async (version: string) => {
    getOrder.push(`idb:${version}`);
    return null;
  };
  try {
    const engine = new OnDeviceStudentEngine();
    engine.hotSwapModel = async () => false; // every candidate fails activation
    await engine.initialize();

    // Descending semver across both stores; binaries fetched one at a time —
    // never an eager read of all binaries up front.
    assert.deepEqual(getOrder, ['idb:3.0.0', 'sqlite:2.0.0', 'sqlite:1.9.0']);
    // Bundled fallback attempted only after stored candidates are exhausted.
    assert.ok(
      env.fetchedUrls.some((url) => url.includes('models/student_model.onnx')),
      'bundled model fetch attempted as fallback'
    );
    assert.equal(engine.isReady(), false);
  } finally {
    sqliteStorage.listStoredModelVersions = storage.sqliteList;
    sqliteStorage.getModel = storage.sqliteGet;
    modelStorage.listStoredVersionKeys = storage.idbList;
    modelStorage.getModel = storage.idbGet;
    env.restore();
  }
});

test('engine stops loading candidates after the first successful activation', async () => {
  const env = installChromeAndFetch();
  const storage = {
    sqliteList: sqliteStorage.listStoredModelVersions.bind(sqliteStorage),
    sqliteGet: sqliteStorage.getModel.bind(sqliteStorage),
    idbList: modelStorage.listStoredVersionKeys.bind(modelStorage),
    idbGet: modelStorage.getModel.bind(modelStorage),
  };
  const getOrder: string[] = [];
  sqliteStorage.listStoredModelVersions = async () => ['2.0.0', '1.9.0'];
  sqliteStorage.getModel = async (version: string) => {
    getOrder.push(`sqlite:${version}`);
    return {
      version,
      buffer: new Uint8Array([1]).buffer,
      metadata: { version } as never,
      savedAt: new Date().toISOString(),
    };
  };
  modelStorage.listStoredVersionKeys = async () => [];
  modelStorage.getModel = storage.idbGet;
  try {
    const engine = new OnDeviceStudentEngine();
    const activated: string[] = [];
    engine.hotSwapModel = async (_buffer, metadata) => {
      activated.push((metadata as { version: string }).version);
      return true;
    };
    await engine.initialize();
    // 2.0.0 activates immediately; the older 1.9.0 binary is never fetched.
    assert.deepEqual(getOrder, ['sqlite:2.0.0']);
    assert.deepEqual(activated, ['2.0.0']);
  } finally {
    sqliteStorage.listStoredModelVersions = storage.sqliteList;
    sqliteStorage.getModel = storage.sqliteGet;
    modelStorage.listStoredVersionKeys = storage.idbList;
    modelStorage.getModel = storage.idbGet;
    env.restore();
  }
});

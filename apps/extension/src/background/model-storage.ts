/**
 * Model Storage Service using IndexedDB for caching ONNX binaries and metadata.
 * Provides resilient persistence for multi-megabyte model checkpoints.
 */

import {
  ModelMetadataSchema,
  ModelSyncStatusSchema,
  type ModelMetadata,
  type ModelSyncStatus,
} from '@phishguard/types';

export interface StoredModelRecord {
  version: string;
  buffer: ArrayBuffer;
  metadata: ModelMetadata;
  savedAt: string;
}

const DB_NAME = 'phishguard_models_db';
const DB_VERSION = 1;
const STORE_MODELS = 'models';
const STORE_META = 'sync_meta';

export class ModelStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryFallback: Map<string, StoredModelRecord> = new Map();
  private metaMemoryFallback: Map<string, unknown> = new Map();

  private isIndexedDBAvailable(): boolean {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  private async openDB(): Promise<IDBDatabase> {
    if (!this.isIndexedDBAvailable()) {
      throw new Error('IndexedDB is not available in current execution context');
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_MODELS)) {
          db.createObjectStore(STORE_MODELS, { keyPath: 'version' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /**
   * Save a verified model binary and its cryptographic metadata to persistent storage.
   */
  public async saveModel(
    version: string,
    buffer: ArrayBuffer,
    metadata: ModelMetadata
  ): Promise<void> {
    const parsedMetadata = ModelMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success || parsedMetadata.data.version !== version) {
      throw new Error('Invalid model metadata');
    }
    if (parsedMetadata.data.fileSizeBytes !== buffer.byteLength) {
      throw new Error('Model binary size does not match metadata');
    }
    const digest = await crypto.subtle.digest('SHA-256', buffer.slice(0));
    const actualHash = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    if (actualHash.toLowerCase() !== parsedMetadata.data.sha256.toLowerCase()) {
      throw new Error('Model binary hash does not match metadata');
    }
    const record: StoredModelRecord = {
      version,
      buffer,
      metadata: parsedMetadata.data,
      savedAt: new Date().toISOString(),
    };

    if (!this.isIndexedDBAvailable()) {
      this.memoryFallback.set(version, record);
      return;
    }

    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_MODELS], 'readwrite');
        const store = tx.objectStore(STORE_MODELS);
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[PhishGuard] Failed to write to IndexedDB, fallback to memory cache:', err);
      this.memoryFallback.set(version, record);
    }
  }

  /**
   * Retrieve a specific model version binary and metadata.
   */
  public async getModel(version: string): Promise<StoredModelRecord | null> {
    if (!this.isIndexedDBAvailable()) {
      return this.memoryFallback.get(version) || null;
    }

    try {
      const db = await this.openDB();
      return await new Promise<StoredModelRecord | null>((resolve, reject) => {
        const tx = db.transaction([STORE_MODELS], 'readonly');
        const store = tx.objectStore(STORE_MODELS);
        const req = store.get(version);
        req.onsuccess = () => {
          const record = req.result as StoredModelRecord | undefined;
          if (!record || record.version !== version) {
            resolve(null);
            return;
          }
          const metadata = ModelMetadataSchema.safeParse(record.metadata);
          resolve(metadata.success ? { ...record, metadata: metadata.data } : null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[PhishGuard] Failed to read from IndexedDB, checking memory cache:', err);
      return this.memoryFallback.get(version) || null;
    }
  }

  /**
   * List stored model version keys without reading any model binaries, so
   * callers can lazily fetch one record at a time via `getModel`.
   */
  public async listStoredVersionKeys(): Promise<string[]> {
    if (!this.isIndexedDBAvailable()) {
      return Array.from(this.memoryFallback.keys())
        .sort((a, b) => compareVersions(b, a));
    }

    try {
      const db = await this.openDB();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const tx = db.transaction([STORE_MODELS], 'readonly');
        const req = tx.objectStore(STORE_MODELS).getAllKeys();
        req.onsuccess = () => resolve((req.result as IDBValidKey[] | undefined) ?? []);
        req.onerror = () => reject(req.error);
      });
      return keys.map((key) => String(key)).sort((a, b) => compareVersions(b, a));
    } catch (err) {
      console.warn('[PhishGuard] Failed to list version keys from IndexedDB, returning memory cache:', err);
      return Array.from(this.memoryFallback.keys());
    }
  }

  /**
   * List all stored model versions sorted by release timestamp descending.
   */
  public async listStoredVersions(): Promise<StoredModelRecord[]> {
    if (!this.isIndexedDBAvailable()) {
      return Array.from(this.memoryFallback.values())
        .flatMap((record) => {
          const metadata = ModelMetadataSchema.safeParse(record.metadata);
          return metadata.success && metadata.data.version === record.version
            ? [{ ...record, metadata: metadata.data }]
            : [];
        })
        .sort((a, b) => compareVersions(b.version, a.version));
    }

    try {
      const db = await this.openDB();
      return await new Promise<StoredModelRecord[]>((resolve, reject) => {
        const tx = db.transaction([STORE_MODELS], 'readonly');
        const store = tx.objectStore(STORE_MODELS);
        const req = store.getAll();
        req.onsuccess = () => {
          const records = ((req.result || []) as StoredModelRecord[])
            .flatMap((record) => {
              const metadata = ModelMetadataSchema.safeParse(record.metadata);
              return metadata.success && metadata.data.version === record.version
                ? [{ ...record, metadata: metadata.data }]
                : [];
            })
            .sort((a, b) => compareVersions(b.version, a.version));
          resolve(records);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[PhishGuard] Failed to list from IndexedDB, returning memory cache:', err);
      return Array.from(this.memoryFallback.values());
    }
  }

  /**
   * Get the latest model stored locally.
   */
  public async getLatestStoredModel(): Promise<StoredModelRecord | null> {
    const list = await this.listStoredVersions();
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Save sync status metadata snapshot.
   */
  public async saveSyncStatus(status: ModelSyncStatus): Promise<void> {
    const parsedStatus = ModelSyncStatusSchema.safeParse(status);
    if (!parsedStatus.success) throw new Error('Invalid model sync status');
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ modelSyncStatus: parsedStatus.data });
    }

    if (!this.isIndexedDBAvailable()) {
      this.metaMemoryFallback.set('modelSyncStatus', parsedStatus.data);
      return;
    }

    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_META], 'readwrite');
        const store = tx.objectStore(STORE_META);
        store.put({ key: 'modelSyncStatus', value: parsedStatus.data });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      this.metaMemoryFallback.set('modelSyncStatus', parsedStatus.data);
    }
  }

  /**
   * Retrieve last known sync status snapshot.
   */
  public async getSyncStatus(): Promise<ModelSyncStatus | null> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(['modelSyncStatus']);
      if (res.modelSyncStatus) {
        const parsed = ModelSyncStatusSchema.safeParse(res.modelSyncStatus);
        return parsed.success ? parsed.data : null;
      }
    }

    if (!this.isIndexedDBAvailable()) {
      const parsed = ModelSyncStatusSchema.safeParse(this.metaMemoryFallback.get('modelSyncStatus'));
      return parsed.success ? parsed.data : null;
    }

    try {
      const db = await this.openDB();
      return await new Promise<ModelSyncStatus | null>((resolve, reject) => {
        const tx = db.transaction([STORE_META], 'readonly');
        const store = tx.objectStore(STORE_META);
        const req = store.get('modelSyncStatus');
        req.onsuccess = () => {
          const parsed = ModelSyncStatusSchema.safeParse(req.result?.value);
          resolve(parsed.success ? parsed.data : null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      const parsed = ModelSyncStatusSchema.safeParse(this.metaMemoryFallback.get('modelSyncStatus'));
      return parsed.success ? parsed.data : null;
    }
  }
}

function compareVersions(first: string, second: string): number {
  const parse = (version: string): number[] =>
    version.replace(/^v/, '').split(/[+-]/, 1)[0].split('.').map((part) => Number.parseInt(part, 10));
  const left = parse(first);
  const right = parse(second);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return first.localeCompare(second);
}

export const modelStorage = new ModelStorage();

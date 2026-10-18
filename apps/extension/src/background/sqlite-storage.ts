/**
 * Embedded SQLite Frontend Storage for Browser Extension.
 * Powered by sql.js (WebAssembly SQLite) with IndexedDB binary persistence.
 */

import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import {
  ModelMetadataSchema,
  ModelSyncStatusSchema,
  type ModelMetadata,
  type ModelSyncStatus,
} from '@phishguard/types';

export interface InspectionRecord {
  id?: number;
  url: string;
  domain: string;
  riskScore: number;
  action: string;
  modelVersion: string;
  pointerSamples: number;
  keystrokeSamples: number;
  domAnomalies: number;
  timestamp: string;
}

export interface StoredModelSQLite {
  version: string;
  buffer: ArrayBuffer;
  metadata: ModelMetadata;
  savedAt: string;
}

const IDB_NAME = 'phishguard_sqlite_db';
const IDB_STORE = 'sqlite_store';
const IDB_KEY = 'phishguard.sqlite';

function compareModelVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return match
      ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? null }
      : null;
  };
  const first = parse(left);
  const second = parse(right);
  if (!first || !second) return left.localeCompare(right);
  for (let index = 0; index < 3; index++) {
    const difference = first.core[index] - second.core[index];
    if (difference !== 0) return difference;
  }
  if (first.prerelease === null || second.prerelease === null) {
    if (first.prerelease === second.prerelease) return 0;
    return first.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(first.prerelease.length, second.prerelease.length); index++) {
    const a = first.prerelease[index];
    const b = second.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.localeCompare(b);
  }
  return 0;
}

export class SQLiteFrontendStorage {
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        let wasmPath = 'assets/sql-wasm.wasm';
        const globalScope = globalThis as unknown as {
          process?: { versions?: { node?: string } };
          chrome?: { runtime?: { getURL?: (path: string) => string } };
        };

        if (globalScope.process?.versions?.node) {
          try {
            const nodeModule = (await new Function('return import("node:module")')()) as {
              createRequire: (url: string) => { resolve: (id: string) => string };
            };
            const req = nodeModule.createRequire(import.meta.url);
            wasmPath = req.resolve('sql.js/dist/sql-wasm.wasm');
          } catch {}
        } else if (globalScope.chrome?.runtime?.getURL) {
          wasmPath = globalScope.chrome.runtime.getURL('assets/sql-wasm.wasm');
        }

        let wasmBinary: ArrayBuffer | undefined;
        if (!globalScope.process?.versions?.node && typeof fetch === 'function') {
          const candidatePaths = globalScope.chrome?.runtime?.getURL
            ? [
                globalScope.chrome.runtime.getURL('dist/assets/sql-wasm.wasm'),
                globalScope.chrome.runtime.getURL('assets/sql-wasm.wasm'),
              ]
            : [wasmPath];

          for (const candUrl of candidatePaths) {
            try {
              const resp = await fetch(candUrl);
              if (resp.ok) {
                wasmBinary = await resp.arrayBuffer();
                wasmPath = candUrl;
                break;
              }
            } catch (fetchErr) {
              console.warn('[PhishGuard-SQLite] Could not pre-fetch WASM binary from', candUrl, fetchErr);
            }
          }
        }

        this.SQL = await initSqlJs({
          locateFile: () => wasmPath,
          ...(wasmBinary ? { wasmBinary } : {}),
        });



        // Attempt to load existing SQLite database binary from IndexedDB
        const existingData = await this.readBinaryFromIndexedDB();
        if (existingData && existingData.byteLength > 0) {
          this.db = new this.SQL.Database(new Uint8Array(existingData));
          console.log('[PhishGuard-SQLite] Loaded existing database from persistent storage');
        } else {
          this.db = new this.SQL.Database();
          console.log('[PhishGuard-SQLite] Initialized new empty SQLite database');
        }

        // Initialize schema tables
        this.db.run(`
          CREATE TABLE IF NOT EXISTS models (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            architecture TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            file_size_bytes INTEGER NOT NULL,
            binary_blob BLOB,
            metrics_json TEXT NOT NULL,
            changelog_json TEXT NOT NULL,
            download_url TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            metadata_json TEXT
          );

          CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS inspection_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            domain TEXT NOT NULL,
            risk_score REAL NOT NULL,
            action TEXT NOT NULL,
            model_version TEXT NOT NULL,
            pointer_samples INTEGER NOT NULL,
            keystroke_samples INTEGER NOT NULL,
            dom_anomalies INTEGER NOT NULL,
            timestamp TEXT NOT NULL
          );
        `);
        const modelColumns = this.db.exec('PRAGMA table_info(models)')[0]?.values ?? [];
        if (!modelColumns.some((column) => column[1] === 'metadata_json')) {
          this.db.run('ALTER TABLE models ADD COLUMN metadata_json TEXT');
        }

        this.isInitialized = true;
      } catch (err) {
        console.error('[PhishGuard-SQLite] Initialization error:', err);
        throw err;
      }
    })();

    return this.initPromise;
  }

  public isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  private restoreModelMetadata(row: Record<string, unknown>): ModelMetadata | null {
    const metadataJson = row.metadata_json;
    if (typeof metadataJson === 'string' && metadataJson.length > 0) {
      try {
        const parsed = ModelMetadataSchema.safeParse(JSON.parse(metadataJson));
        return parsed.success && parsed.data.version === String(row.version) ? parsed.data : null;
      } catch {
        return null;
      }
    }
    try {
      const parsed = ModelMetadataSchema.safeParse({
        version: String(row.version),
        name: String(row.name),
        architecture: String(row.architecture),
        sha256: String(row.sha256),
        fileSizeBytes: Number(row.file_size_bytes),
        releasedAt: String(row.saved_at),
        minExtensionVersion: '0.1.0',
        features: ['x', 'y', 'dx', 'dy', 'v', 'theta'],
        metrics: JSON.parse(String(row.metrics_json)),
        changelog: JSON.parse(String(row.changelog_json)),
        downloadUrl: String(row.download_url),
      });
      return parsed.success && parsed.data.version === String(row.version) ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Persist current SQLite binary state to IndexedDB.
   */
  private async persistNow(): Promise<void> {
    if (!this.db) return;
    try {
      const binary = this.db.export();
      await this.writeBinaryToIndexedDB(binary.buffer as ArrayBuffer);
    } catch (e) {
      console.warn('[PhishGuard-SQLite] Failed to persist SQLite state to IndexedDB:', e);
    }
  }

  private static readonly PERSIST_BATCH_MS = 250;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPersist: Promise<void> | null = null;
  private pendingPersistResolve: (() => void) | null = null;

  /**
   * Flush any queued batch and persist immediately. Model binaries and sync
   * state keep immediate durability; a direct flush also settles waiters of a
   * pending batch since it supersedes it.
   */
  private async persist(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const resolve = this.pendingPersistResolve;
    this.pendingPersist = null;
    this.pendingPersistResolve = null;
    try {
      await this.persistNow();
    } finally {
      resolve?.();
    }
  }

  /**
   * Coalesce frequent writes (telemetry audit records) into one export per
   * batch window. All callers within the window share the same flush promise.
   */
  private schedulePersist(): Promise<void> {
    if (!this.pendingPersist) {
      this.pendingPersist = new Promise<void>((resolve) => {
        this.pendingPersistResolve = resolve;
      });
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        const resolve = this.pendingPersistResolve;
        this.pendingPersist = null;
        this.pendingPersistResolve = null;
        void this.persistNow().finally(() => resolve?.());
      }, SQLiteFrontendStorage.PERSIST_BATCH_MS);
    }
    return this.pendingPersist;
  }

  /**
   * Save a model release binary and metadata into SQLite.
   */
  public async saveModel(
    version: string,
    buffer: ArrayBuffer,
    metadata: ModelMetadata
  ): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('SQLite database not initialized');
    const parsedMetadata = ModelMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success || parsedMetadata.data.version !== version) {
      throw new Error('Invalid model metadata');
    }
    metadata = parsedMetadata.data;
    if (metadata.fileSizeBytes !== buffer.byteLength) {
      throw new Error('Model binary size does not match metadata');
    }
    const digest = await crypto.subtle.digest('SHA-256', buffer.slice(0));
    const actualHash = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    if (actualHash.toLowerCase() !== metadata.sha256.toLowerCase()) {
      throw new Error('Model binary hash does not match metadata');
    }

    const uint8Blob = new Uint8Array(buffer);
    const metricsJson = JSON.stringify(metadata.metrics);
    const changelogJson = JSON.stringify(metadata.changelog || []);
    const savedAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO models (
        version, name, architecture, sha256, file_size_bytes,
        binary_blob, metrics_json, changelog_json, download_url, saved_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      version,
      metadata.name,
      metadata.architecture,
      metadata.sha256,
      metadata.fileSizeBytes,
      uint8Blob,
      metricsJson,
      changelogJson,
      metadata.downloadUrl,
      savedAt,
      JSON.stringify(metadata),
    ]);
    stmt.free();

    await this.persist();
  }

  /**
   * Retrieve a model binary and metadata by SemVer.
   */
  public async getModel(version: string): Promise<StoredModelSQLite | null> {
    await this.init();
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT version, name, architecture, sha256, file_size_bytes,
             binary_blob, metrics_json, changelog_json, download_url, saved_at, metadata_json
      FROM models WHERE version = ?
    `);

    stmt.bind([version]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();

    const rawBlob = row.binary_blob as Uint8Array | null;
    const arrayBuf = rawBlob ? (rawBlob.buffer.slice(rawBlob.byteOffset, rawBlob.byteOffset + rawBlob.byteLength) as ArrayBuffer) : new ArrayBuffer(0);

    const metadata = this.restoreModelMetadata(row);
    if (!metadata) return null;

    return {
      version: String(row.version),
      buffer: arrayBuf,
      metadata,
      savedAt: String(row.saved_at),
    };
  }

  /**
   * Get the latest stored model by saved date.
   */
  public async getLatestStoredModel(): Promise<StoredModelSQLite | null> {
    const models = await this.listStoredModels();
    return models[0] ?? null;
  }

  /**
   * List stored model versions without reading any binary blobs, so callers
   * can lazily fetch one model at a time via `getModel`.
   */
  public async listStoredModelVersions(): Promise<string[]> {
    await this.init();
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT version FROM models');
    const versions: string[] = [];
    while (stmt.step()) versions.push(String(stmt.getAsObject().version));
    stmt.free();
    versions.sort((first, second) => compareModelVersions(second, first));
    return versions;
  }

  public async listStoredModels(): Promise<StoredModelSQLite[]> {
    const versions = await this.listStoredModelVersions();
    const records: StoredModelSQLite[] = [];
    for (const version of versions) {
      const record = await this.getModel(version);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Save model sync status into SQLite key-value store.
   */
  public async saveSyncStatus(status: ModelSyncStatus): Promise<void> {
    const parsed = ModelSyncStatusSchema.safeParse(status);
    if (!parsed.success) throw new Error('Invalid model sync status');
    await this.init();
    if (this.db) {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
      stmt.run(['modelSyncStatus', JSON.stringify(parsed.data)]);
      stmt.free();
      await this.persist();
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ modelSyncStatus: parsed.data });
    }
  }

  /**
   * Retrieve model sync status from SQLite.
   */
  public async getSyncStatus(): Promise<ModelSyncStatus | null> {
    await this.init();
    if (this.db) {
      const stmt = this.db.prepare('SELECT value FROM sync_state WHERE key = ?');
      stmt.bind(['modelSyncStatus']);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        try {
          const parsed = ModelSyncStatusSchema.safeParse(JSON.parse(String(row.value)));
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      }
      stmt.free();
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(['modelSyncStatus']);
      const parsed = ModelSyncStatusSchema.safeParse(res.modelSyncStatus);
      if (parsed.success) return parsed.data;
    }

    return null;
  }

  /**
   * Record a telemetry evaluation into the SQLite audit table.
   */
  public async recordInspection(record: Omit<InspectionRecord, 'id'>): Promise<void> {
    await this.init();
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT INTO inspection_history (
        url, domain, risk_score, action, model_version,
        pointer_samples, keystroke_samples, dom_anomalies, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      record.url,
      record.domain,
      record.riskScore,
      record.action,
      record.modelVersion,
      record.pointerSamples,
      record.keystrokeSamples,
      record.domAnomalies,
      record.timestamp,
    ]);
    stmt.free();

    await this.schedulePersist();
  }

  /**
   * Fetch recent page evaluation history from SQLite.
   */
  public async getRecentInspections(limit = 10): Promise<InspectionRecord[]> {
    await this.init();
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT id, url, domain, risk_score, action, model_version,
             pointer_samples, keystroke_samples, dom_anomalies, timestamp
      FROM inspection_history ORDER BY id DESC LIMIT ?
    `);

    stmt.bind([limit]);
    const results: InspectionRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: Number(row.id),
        url: String(row.url),
        domain: String(row.domain),
        riskScore: Number(row.risk_score),
        action: String(row.action),
        modelVersion: String(row.model_version),
        pointerSamples: Number(row.pointer_samples),
        keystrokeSamples: Number(row.keystroke_samples),
        domAnomalies: Number(row.dom_anomalies),
        timestamp: String(row.timestamp),
      });
    }
    stmt.free();
    return results;
  }

  // --- IndexedDB Backing Helpers ---
  private idbPromise: Promise<IDBDatabase> | null = null;

  private openIndexedDB(): Promise<IDBDatabase> {
    if (!this.idbPromise) {
      const opened = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined' || indexedDB === null) {
          return reject(new Error('IndexedDB not available'));
        }
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      this.idbPromise = opened;
      opened.catch(() => {
        if (this.idbPromise === opened) this.idbPromise = null;
      });
    }
    return this.idbPromise;
  }

  private async readBinaryFromIndexedDB(): Promise<ArrayBuffer | null> {
    try {
      const idb = await this.openIndexedDB();
      return new Promise((resolve) => {
        const tx = idb.transaction([IDB_STORE], 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(IDB_KEY);
        req.onsuccess = () => resolve(req.result ? (req.result as ArrayBuffer) : null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  private async writeBinaryToIndexedDB(buffer: ArrayBuffer): Promise<void> {
    try {
      const idb = await this.openIndexedDB();
      return await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction([IDB_STORE], 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.put(buffer, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (e) {
      // Ignore if IndexedDB is not available
    }
  }
}

export const sqliteStorage = new SQLiteFrontendStorage();

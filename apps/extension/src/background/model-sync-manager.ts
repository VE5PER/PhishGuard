/**
 * Model Synchronization Manager for PhishGuard Extension.
 *
 * Responsibilities:
 * 1. Checks backend registry for model updates with cryptographic SHA-256 validation.
 * 2. Streams updated ONNX binaries into IndexedDB cache.
 * 3. Triggers seamless on-device hot-swapping into OnDeviceStudentEngine.
 * 4. Gracefully falls back to cached or local bundled models when offline.
 */

import type {
  CheckUpdateRequest,
  CheckUpdateResponse,
  ModelMetadata,
  ModelSyncStatus,
} from '@phishguard/types';
import { CheckUpdateResponseSchema, ModelMetadataSchema } from '@phishguard/types';
import { sqliteStorage } from './sqlite-storage.js';
import { modelStorage } from './model-storage.js';
import type { OnDeviceStudentEngine } from './onnx-engine.js';


export async function computeBufferSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

import { DEFAULT_BACKEND_URL } from '../config.js';

function compareVersions(first: string, second: string): number {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? null } : null;
  };
  const a = parse(first);
  const b = parse(second);
  if (!a || !b) return first.localeCompare(second);
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return difference;
  }
  if (a.prerelease === null || b.prerelease === null) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left.localeCompare(right);
  }
  return 0;
}

export interface NegotiatedGatewayCapabilities {
  telemetryEvidenceVersion: 2;
  modelInputContracts: Array<'student-v1' | 'student-v2'>;
  manualEscalation: boolean;
}

export class ModelSyncManager {
  private backendBaseUrl: string;
  private gatewayCapabilities: NegotiatedGatewayCapabilities | null = null;

  constructor(backendBaseUrl: string = DEFAULT_BACKEND_URL) {
    this.backendBaseUrl = backendBaseUrl.replace(/\/$/, '');
  }

  public getBackendUrl(): string {
    return this.backendBaseUrl;
  }

  public setBackendUrl(url: string): void {
    this.backendBaseUrl = url.replace(/\/$/, '');
  }

  public setGatewayCapabilities(capabilities: NegotiatedGatewayCapabilities | null): void {
    this.gatewayCapabilities = capabilities;
  }

  /**
   * Check whether a newer student model is available on the backend registry.
   */
  public async checkUpdate(
    currentVersion: string,
    currentSha256?: string
  ): Promise<CheckUpdateResponse> {
    const payload: CheckUpdateRequest = {
      currentVersion,
      currentSha256,
    };
    if (this.gatewayCapabilities?.telemetryEvidenceVersion === 2) {
      const installedVersion = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
        ? chrome.runtime.getManifest().version
        : undefined;
      if (installedVersion) {
        payload.extensionVersion = installedVersion;
        payload.supportedInputContracts = ['student-v1', 'student-v2'];
      }
    }

    const response = await fetch(`${this.backendBaseUrl}/v1/models/check-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Failed to check model updates: HTTP ${response.status} ${response.statusText}`);
    }

    const parsed = CheckUpdateResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid model update response');
    return parsed.data;
  }

  /**
   * Check for model update based on current local version (either explicitly passed or from active engine/storage).
   */
  public async checkForUpdate(
    currentVersionOrEngine?: string | OnDeviceStudentEngine,
    currentSha256?: string
  ): Promise<CheckUpdateResponse> {
    let currentVersion = '0.0.0';
    let sha256 = currentSha256;

    if (typeof currentVersionOrEngine === 'string') {
      currentVersion = currentVersionOrEngine;
    } else if (currentVersionOrEngine && typeof (currentVersionOrEngine as OnDeviceStudentEngine).getActiveVersion === 'function') {
      const activeEngine = currentVersionOrEngine as OnDeviceStudentEngine;
      const activeVer = activeEngine.getActiveVersion();
      currentVersion = activeVer || '0.0.0';
      if (!sha256 && activeEngine.isReady()) {
        sha256 = activeEngine.getActiveMetadata()?.sha256;
      }
    } else {
      const stored = await modelStorage.getSyncStatus();
      if (stored?.currentVersion) {
        currentVersion = stored.currentVersion;
        if (!sha256 && stored.currentVersion !== '0.0.0') {
          sha256 = stored.activeMetadata?.sha256;
        }
      }
    }

    return this.checkUpdate(currentVersion, sha256);
  }

  /**
   * Checks for model update based on current local version, downloads the latest
   * version if available, verifies cryptographic SHA-256 integrity, stores it into
   * extension storage (SQLite and IndexedDB), and hot-swaps the active inference engine.
   */
  public async downloadAndStoreLatestModel(
    engine: OnDeviceStudentEngine
  ): Promise<{ status: ModelSyncStatus; updated: boolean; metadata?: ModelMetadata }> {
    const hasActiveModel = engine.isReady();
    const currentVersion = hasActiveModel ? engine.getActiveVersion() : '0.0.0';
    const currentMeta = hasActiveModel ? engine.getActiveMetadata() : null;
    const now = new Date().toISOString();

    const updateCheck = await this.checkUpdate(currentVersion, currentMeta?.sha256);
    const isActuallyNewer = Boolean(
      updateCheck.updateAvailable &&
      updateCheck.latestMetadata &&
      (
        compareVersions(updateCheck.latestMetadata.version, currentVersion) > 0 ||
        (compareVersions(updateCheck.latestMetadata.version, currentVersion) === 0 &&
          currentMeta !== null &&
          updateCheck.latestMetadata.sha256.toLowerCase() !== currentMeta.sha256.toLowerCase())
      )
    );

    if (isActuallyNewer && updateCheck.latestMetadata) {
      console.log(`[PhishGuard] Update available: local v${currentVersion} -> latest v${updateCheck.latestMetadata.version}`);

      // Download, cryptographically verify SHA-256
      const { buffer, metadata } = await this.downloadAndVerifyModel(
        updateCheck.latestMetadata.version,
        updateCheck.latestMetadata
      );

      // Hot-swap into engine for on-device inference
      const swapSuccess = await engine.hotSwapModel(buffer, metadata, 'REMOTE_SYNCED');
      if (!swapSuccess) {
        throw new Error(`Engine failed to hot-swap to downloaded version ${metadata.version}`);
      }
      // Store into extension storage (both SQLite BLOB and IndexedDB)
      await this.persistVerifiedModel(buffer, metadata);

      const status: ModelSyncStatus = {
        currentVersion: metadata.version,
        latestAvailableVersion: metadata.version,
        isLatest: true,
        lastSyncAttempt: now,
        syncState: 'ONLINE_SYNCED',
        backendReachable: true,
        modelSource: 'REMOTE_SYNCED',
        activeMetadata: metadata,
      };

      try {
        await sqliteStorage.saveSyncStatus(status);
      } catch {}
      await modelStorage.saveSyncStatus(status);

      return { status, updated: true, metadata };
    }

    // Already up to date
    const status: ModelSyncStatus = {
      currentVersion: engine.isReady() ? engine.getActiveVersion() : '0.0.0',
      latestAvailableVersion: updateCheck.latestMetadata?.version || currentVersion,
      isLatest: engine.isReady() && updateCheck.latestMetadata?.version === engine.getActiveVersion(),
      lastSyncAttempt: now,
      syncState: engine.isReady() ? 'ONLINE_SYNCED' : 'SYNC_ERROR',
      backendReachable: true,
      modelSource: engine.getActiveSource(),
      activeMetadata: engine.getActiveMetadata(),
    };

    try {
      await sqliteStorage.saveSyncStatus(status);
    } catch {}
    await modelStorage.saveSyncStatus(status);

    return { status, updated: false, metadata: engine.getActiveMetadata() ?? undefined };
  }

  /**
   * Fetch model metadata by SemVer.
   */
  public async fetchModelMetadata(version: string): Promise<ModelMetadata> {
    const response = await fetch(`${this.backendBaseUrl}/v1/models/${version}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata for v${version}: HTTP ${response.status}`);
    }
    const parsed = ModelMetadataSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid model metadata response');
    return parsed.data;
  }

  /**
   * Download model binary, cryptographically verify SHA-256 digest, and store in local DB.
   */
  public async downloadAndVerifyModel(
    version: string,
    expectedMetadata?: ModelMetadata
  ): Promise<{ buffer: ArrayBuffer; metadata: ModelMetadata }> {
    const candidate = expectedMetadata || (await this.fetchModelMetadata(version));
    const parsedMetadata = ModelMetadataSchema.safeParse(candidate);
    if (!parsedMetadata.success || parsedMetadata.data.version !== version) {
      throw new Error('Invalid model metadata');
    }
    const metadata = parsedMetadata.data;

    const downloadUrl = metadata.downloadUrl.startsWith('http')
      ? metadata.downloadUrl
      : `${this.backendBaseUrl}${metadata.downloadUrl.startsWith('/') ? '' : '/'}${metadata.downloadUrl}`;

    console.log(`[PhishGuard] Downloading student model v${version} from ${downloadUrl}...`);
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Failed to download model binary: HTTP ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength !== metadata.fileSizeBytes) {
      throw new Error('Model binary size does not match metadata');
    }

    // Verify SHA-256 cryptographic integrity
    const computedHash = await computeBufferSha256(buffer);
    if (computedHash.toLowerCase() !== metadata.sha256.toLowerCase()) {
      throw new Error(
        `Cryptographic integrity violation: Expected SHA-256 ${metadata.sha256}, got ${computedHash}`
      );
    }

    console.log(`[PhishGuard] Cryptographic integrity verified (SHA-256: ${computedHash.slice(0, 16)}...)`);

    return { buffer, metadata };
  }

  private async persistVerifiedModel(buffer: ArrayBuffer, metadata: ModelMetadata): Promise<void> {
    // Persist to embedded SQLite frontend storage and IndexedDB fallback
    try {
      await sqliteStorage.saveModel(metadata.version, buffer, metadata);
    } catch (e) {
      console.warn('[PhishGuard] SQLite save error:', e);
    }
    await modelStorage.saveModel(metadata.version, buffer, metadata);
  }

  /**
   * Orchestrates the complete synchronization cycle:
   * 1. Ping backend & check for newer release.
   * 2. If available, download, verify SHA-256, store in IndexedDB, and hot-swap engine.
   * 3. If backend unreachable, fallback to latest cached model in IndexedDB or bundled model.
   */
  public async syncWithBackend(engine: OnDeviceStudentEngine): Promise<ModelSyncStatus> {
    const hasActiveModel = engine.isReady();
    const currentVersion = hasActiveModel ? engine.getActiveVersion() : '0.0.0';
    const currentMeta = hasActiveModel ? engine.getActiveMetadata() : null;
    const now = new Date().toISOString();

    try {
      console.log(`[PhishGuard] Querying backend model registry (current active: v${currentVersion})...`);
      const updateCheck = await this.checkUpdate(currentVersion, currentMeta?.sha256);
      const isActuallyNewer = Boolean(
        updateCheck.updateAvailable &&
        updateCheck.latestMetadata &&
        (
          compareVersions(updateCheck.latestMetadata.version, currentVersion) > 0 ||
          (compareVersions(updateCheck.latestMetadata.version, currentVersion) === 0 &&
            currentMeta !== null &&
            updateCheck.latestMetadata.sha256.toLowerCase() !== currentMeta.sha256.toLowerCase())
        )
      );

      if (isActuallyNewer && updateCheck.latestMetadata) {
        console.log(`[PhishGuard] New model version detected: v${updateCheck.latestMetadata.version}`);

        // Download, verify SHA-256 and cache
        const { buffer, metadata } = await this.downloadAndVerifyModel(
          updateCheck.latestMetadata.version,
          updateCheck.latestMetadata
        );

        // Perform live hot-swap in ONNX engine
        const swapSuccess = await engine.hotSwapModel(buffer, metadata, 'REMOTE_SYNCED');
        if (!swapSuccess) {
          throw new Error(`Engine failed to hot-swap to version ${metadata.version}`);
        }
        await this.persistVerifiedModel(buffer, metadata);

        const status: ModelSyncStatus = {
          currentVersion: metadata.version,
          latestAvailableVersion: metadata.version,
          isLatest: true,
          lastSyncAttempt: now,
          syncState: 'ONLINE_SYNCED',
          backendReachable: true,
          modelSource: 'REMOTE_SYNCED',
          activeMetadata: metadata,
        };

        try {
          await sqliteStorage.saveSyncStatus(status);
        } catch {}
        await modelStorage.saveSyncStatus(status);
        return status;
      }

      // No update needed - currently running latest
      const status: ModelSyncStatus = {
        currentVersion: engine.isReady() ? engine.getActiveVersion() : '0.0.0',
        latestAvailableVersion: updateCheck.latestMetadata.version,
        isLatest: engine.isReady() && updateCheck.latestMetadata.version === engine.getActiveVersion(),
        lastSyncAttempt: now,
        syncState: engine.isReady() ? 'ONLINE_SYNCED' : 'SYNC_ERROR',
        backendReachable: true,
        modelSource: engine.getActiveSource(),
        activeMetadata: engine.getActiveMetadata(),
      };

      try {
        await sqliteStorage.saveSyncStatus(status);
      } catch {}
      await modelStorage.saveSyncStatus(status);
      return status;
    } catch (err) {
      console.warn('[PhishGuard] Model sync query failed, evaluating offline fallback:', err);

      // Check if we have cached releases in SQLite or IndexedDB — enumerate
      // version keys only, then fetch at most one binary at a time.
      const cachedCandidates: Array<{
        version: string;
        load: () => Promise<{ buffer: ArrayBuffer; metadata: ModelMetadata } | null>;
      }> = [];
      try {
        for (const version of await sqliteStorage.listStoredModelVersions()) {
          cachedCandidates.push({
            version,
            load: async () => await sqliteStorage.getModel(version),
          });
        }
      } catch {}
      try {
        for (const version of await modelStorage.listStoredVersionKeys()) {
          cachedCandidates.push({
            version,
            load: async () => await modelStorage.getModel(version),
          });
        }
      } catch {}
      cachedCandidates.sort((first, second) => compareVersions(second.version, first.version));
      const activeHash = engine.getActiveMetadata()?.sha256 ?? null;
      for (const candidate of cachedCandidates) {
        const versionDifference = compareVersions(candidate.version, currentVersion);
        if (engine.isReady() && versionDifference < 0) {
          continue;
        }
        let cached: { buffer: ArrayBuffer; metadata: ModelMetadata } | null = null;
        try {
          cached = await candidate.load();
        } catch {
          cached = null;
        }
        if (!cached) continue;
        if (engine.isReady() &&
          versionDifference === 0 &&
          cached.metadata.sha256.toLowerCase() === activeHash?.toLowerCase()
        ) {
          continue;
        }
        const restored = await engine.hotSwapModel(cached.buffer, cached.metadata, 'CACHE_STORAGE');
        if (!restored) continue;
        const fallbackStatus: ModelSyncStatus = {
          currentVersion: candidate.version,
          latestAvailableVersion: candidate.version,
          isLatest: false,
          lastSyncAttempt: now,
          syncState: 'OFFLINE_FALLBACK',
          backendReachable: false,
          modelSource: 'CACHE_STORAGE',
          activeMetadata: cached.metadata,
        };
        try {
          await sqliteStorage.saveSyncStatus(fallbackStatus);
        } catch {}
        await modelStorage.saveSyncStatus(fallbackStatus);
        return fallbackStatus;
      }

      const fallbackStatus: ModelSyncStatus = {
        // Fallback to local baseline
        currentVersion: engine.isReady() ? engine.getActiveVersion() : '0.0.0',
        latestAvailableVersion: engine.isReady() ? engine.getActiveVersion() : '0.0.0',
        isLatest: false,
        lastSyncAttempt: now,
        syncState: 'OFFLINE_FALLBACK',
        backendReachable: false,
        modelSource: engine.getActiveSource(),
        activeMetadata: engine.getActiveMetadata() || undefined,
      };
      await modelStorage.saveSyncStatus(fallbackStatus);
      return fallbackStatus;
    }
  }
}

export const modelSyncManager = new ModelSyncManager();

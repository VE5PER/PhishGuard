/**
 * PhishGuard Background Service Worker
 *
 * Coordinates:
 * 1. On-device student ONNX model inferencing.
 * 2. Tri-state decision routing:
 *    - SAFE (< 0.15): zero network traffic.
 *    - BLOCK (> 0.85): instant on-screen banner directive to content script.
 *    - AMBIGUOUS (0.15 - 0.85): cloud escalation dispatch to FastAPI gateway.
 * 3. Autonomous Model Version Synchronization:
 *    - Polls FastAPI registry for newer ONNX releases.
 *    - Cryptographically validates SHA-256 hashes.
 *    - Hot-swaps inference engine seamlessly.
 *    - Gracefully falls back to local cache/bundled model if backend is offline.
 * 4. Chrome storage caching for popup dashboard.
 */

import { OnDeviceStudentEngine } from './onnx-engine.js';
import { modelSyncManager } from './model-sync-manager.js';
import { modelStorage } from './model-storage.js';
import { sqliteStorage } from './sqlite-storage.js';
import { extensionUpdateManager } from './extension-update-manager.js';
import { captureScreenshotForUpload, captureVisualTensorWithStatus } from './vision-capture.js';
import { DEFAULT_BACKEND_URL } from '../config.js';
import {
  PerTabLatestQueue,
  PerTabSerialQueue,
  TabAnalysisStateStore,
  TabAnalysisSnapshotSchema,
  PageIdentitySchema,
  type GetTabAnalysisRequest,
  type PageEvaluationEnvelope,
  type TabAnalysisSnapshot,
} from './tab-analysis-state.js';
import type {
  InteractionTelemetryPayload,
  EscalationPayload,
  CloudInferenceVerdict,
  ModelSyncStatus,
  WarningPresentationType,
} from '@phishguard/types';
import {
  CloudInferenceVerdictSchema,
  InteractionTelemetryPayloadSchema,
} from '@phishguard/types';
import { z } from 'zod';
import { sanitizeDisplayedBrands } from './page-context.js';
import type { LocalRuntimeState, VisionUnavailableReason } from './types.js';
import {
  decideSmartWarningType,
} from '../warning-config.js';

export const engine = new OnDeviceStudentEngine();
let localInitializationPromise: Promise<void> | null = null;
let localInitializationSettled = false;
const ESCALATION_TIMEOUT_MS = 30_000;
let currentBackendUrl = DEFAULT_BACKEND_URL;
export const tabAnalysisStore = new TabAnalysisStateStore();
const tabEvaluationQueue = new PerTabLatestQueue<Record<string, unknown>>();
const tabSessionStorageQueue = new PerTabSerialQueue();
const legacyEvaluationGenerations = new Map<number, number>();
const legacyPageContexts = new Map<number, { url: string; pageSessionId: string; navigationGeneration: number }>();
const GatewayCapabilitiesSchema = z.object({
  telemetryEvidenceVersion: z.literal(2),
  modelInputContracts: z.array(z.enum(['student-v1', 'student-v2'])),
  manualEscalation: z.boolean(),
}).strict();
type GatewayCapabilities = z.infer<typeof GatewayCapabilitiesSchema>;
let gatewayCapabilitiesCache: { backendUrl: string; fetchedAt: number; capabilities: GatewayCapabilities } | null = null;

async function negotiateGatewayCapabilities(force = false): Promise<GatewayCapabilities | null> {
  if (
    !force &&
    gatewayCapabilitiesCache?.backendUrl === currentBackendUrl &&
    Date.now() - gatewayCapabilitiesCache.fetchedAt < 300_000
  ) {
    return gatewayCapabilitiesCache.capabilities;
  }
  try {
    const response = await fetch(`${currentBackendUrl}/health`, { method: 'GET' });
    if (!response.ok) {
      gatewayCapabilitiesCache = null;
      modelSyncManager.setGatewayCapabilities(null);
      return null;
    }
    const body = await response.json() as { capabilities?: unknown };
    const parsed = GatewayCapabilitiesSchema.safeParse(body.capabilities);
    if (!parsed.success) {
      gatewayCapabilitiesCache = null;
      modelSyncManager.setGatewayCapabilities(null);
      return null;
    }
    gatewayCapabilitiesCache = {
      backendUrl: currentBackendUrl,
      fetchedAt: Date.now(),
      capabilities: parsed.data,
    };
    modelSyncManager.setGatewayCapabilities(parsed.data);
    return parsed.data;
  } catch {
    gatewayCapabilitiesCache = null;
    modelSyncManager.setGatewayCapabilities(null);
    return null;
  }
}

function invalidateVisionCacheAfterModelChange(previousHash: string | null): void {
  const nextHash = engine.getActiveMetadata()?.sha256 ?? null;
  if (nextHash !== previousHash) clearAllTabVisionCache();
}

// Initialize ONNX runtime, SQLite database, load backend config, and synchronize model on startup
async function initializeLocalSystem(): Promise<void> {
  // 1. Initialize embedded SQLite frontend storage
  await sqliteStorage.init().catch((e) => console.warn('[PhishGuard] SQLite init warning:', e));

  // 2. Load configured backend URL from storage if available, defaulting to build BACKEND_URL
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['backendUrl']);
      currentBackendUrl = stored.backendUrl
        ? stored.backendUrl.replace(/\/+$/, '')
        : DEFAULT_BACKEND_URL;
      modelSyncManager.setBackendUrl(currentBackendUrl);
      extensionUpdateManager.setBackendUrl(currentBackendUrl);
    } catch {
      currentBackendUrl = DEFAULT_BACKEND_URL;
    }
  }

  // 3. Initialize bundled baseline engine
  await engine.initialize();
}

function ensureLocalInitialization(): Promise<void> {
  if (!localInitializationPromise) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      localInitializationSettled = true;
      localInitializationPromise = Promise.resolve();
    } else {
      localInitializationPromise = initializeLocalSystem()
        .catch((err) => {
          console.warn('[PhishGuard] Local initialization warning:', err);
        })
        .finally(() => {
          localInitializationSettled = true;
        });
    }
  }
  return localInitializationPromise;
}

function getLocalRuntimeState(): LocalRuntimeState {
  if (!localInitializationPromise || !localInitializationSettled) return 'loading';
  return engine.isReady() ? 'ready' : 'unavailable';
}

async function syncModelWithBackend(forceCapabilities: boolean): Promise<ModelSyncStatus> {
  await ensureLocalInitialization();
  const modelHashBeforeSync = engine.getActiveMetadata()?.sha256 ?? null;
  await negotiateGatewayCapabilities(forceCapabilities);
  const syncStatus = await modelSyncManager.syncWithBackend(engine);
  invalidateVisionCacheAfterModelChange(modelHashBeforeSync);
  return syncStatus;
}

async function downloadLatestModel() {
  await ensureLocalInitialization();
  const modelHashBeforeSync = engine.getActiveMetadata()?.sha256 ?? null;
  await negotiateGatewayCapabilities(true);
  const result = await modelSyncManager.downloadAndStoreLatestModel(engine);
  invalidateVisionCacheAfterModelChange(modelHashBeforeSync);
  return result;
}

async function initializeNetworkSystem(): Promise<void> {
  try {
    // 4. Perform background model version sync
    const syncStatus = await syncModelWithBackend(false);
    console.log(
      `[PhishGuard] Startup model sync completed: v${syncStatus.currentVersion} (${syncStatus.syncState}, ${syncStatus.modelSource}) [Endpoint: ${currentBackendUrl}]`
    );
  } catch (err) {
    console.warn('[PhishGuard] Background model synchronization warning:', err);
  }

  // 5. Perform background extension release check
  extensionUpdateManager
    .checkForExtensionUpdate({ interactive: false })
    .then((st) =>
      console.log(
        `[PhishGuard] Startup extension version check: v${st.currentVersion} (latest: ${st.latestVersion}, update: ${st.updateAvailable})`
      )
    )
    .catch((e) => console.warn('[PhishGuard] Extension update check warning:', e));
}

export function initializeSystem(): void {
  void ensureLocalInitialization().then(() => {
    // 6. Re-inject content scripts into all open tabs
    reinjectContentScripts().catch((e) => console.warn('[PhishGuard] Content script re-injection note:', e));
    void initializeNetworkSystem();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  initializeSystem();
}

// Periodic update check alarm (every 60 minutes)
if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
  chrome.alarms.create('CHECK_MODEL_UPDATES', { periodInMinutes: 60 });
  chrome.alarms.create('CHECK_EXTENSION_UPDATES', { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'CHECK_MODEL_UPDATES') {
      syncModelWithBackend(true)
        .then((status) => {
          console.log('[PhishGuard] Periodic model sync:', status.syncState);
        })
        .catch((e) => console.warn('[PhishGuard] Periodic sync failed:', e));
    } else if (alarm.name === 'CHECK_EXTENSION_UPDATES') {
      extensionUpdateManager
        .checkForExtensionUpdate({ interactive: false })
        .then((st) => console.log('[PhishGuard] Periodic extension update check: update=' + st.updateAvailable))
        .catch((e) => console.warn('[PhishGuard] Periodic extension update check failed:', e));
    }
  });
}

async function reinjectContentScripts(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/content.js'] });
    } catch {
      // Restricted pages (e.g. Web Store) reject injection
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'update') return;
    const version = chrome.runtime.getManifest().version;
    console.log(`[PhishGuard] Updated to v${version}; re-injecting content scripts into open tabs`);
    reinjectContentScripts().catch((e) => console.warn('[PhishGuard] Content script re-injection failed:', e));
    chrome.storage?.local?.remove('extensionUpdateStatus').catch(() => {});
    chrome.action?.setBadgeText({ text: '' });
    chrome.action?.setTitle({ title: 'PhishGuard Threat Inspector' });
    chrome.notifications?.create(`phishguard-updated-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'PhishGuard Updated',
      message: `Updated to v${version}.`,
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EVALUATE_TELEMETRY') {
      let payload: InteractionTelemetryPayload;
      try {
        payload = parseAutomaticTelemetry(message.payload);
      } catch {
        sendResponse({ success: false, error: 'Invalid telemetry payload' });
        return false;
      }
      const envelope = getMessageEnvelope(message, payload, sender.tab?.id);
      if (!envelope) {
        sendResponse({ success: false, error: 'Invalid page evaluation envelope' });
        return false;
      }
      const forceVision = Boolean(message.forceVision);
      const visionRecoveryAttempt = typeof message.visionRecoveryAttempt === 'number' &&
        Number.isInteger(message.visionRecoveryAttempt) &&
        message.visionRecoveryAttempt >= 0 &&
        message.visionRecoveryAttempt <= 2
        ? message.visionRecoveryAttempt
        : 0;
      handleTelemetryEvaluation(
        payload,
        sender.tab?.id,
        forceVision,
        envelope,
        visionRecoveryAttempt,
        sanitizeDisplayedBrands(message.displayedBrands)
      )
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) => {
          console.error('[PhishGuard] Evaluation error:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true; // Keep message channel open for async response
    }

    if (message.type === 'GET_TAB_ANALYSIS') {
      const request = message as GetTabAnalysisRequest;
      const tabId = Number(request.tabId);
      if (!Number.isInteger(tabId)) {
        sendResponse({ success: false, error: 'A tab ID is required' });
        return false;
      }
      getTabAnalysisForDisplay(tabId, typeof request.url === 'string' ? request.url : undefined)
        .then((result) => sendResponse({
          success: true,
          snapshot: result ? {
            tabId: result.snapshot.tabId,
            pageSessionId: result.snapshot.pageSessionId,
            navigationGeneration: result.snapshot.navigationGeneration,
            evaluationGeneration: result.snapshot.evaluationGeneration,
            url: result.snapshot.url,
            warningVisible: result.snapshot.warningVisible,
            topologyScanComplete: result.snapshot.topologyScanComplete,
            telemetryId: result.snapshot.telemetryId,
            analysis: result.snapshot.analysis,
            cloudVerdict: result.snapshot.cloudVerdict,
          } : null,
          current: result?.current ?? false,
          evaluationPending: result?.evaluationPending ?? false,
        }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'REQUEST_TAB_EVALUATION') {
      const request = message as { tabId?: unknown; forceVision?: unknown };
      const tabId = Number(request.tabId);
      if (!Number.isInteger(tabId)) {
        sendResponse({ success: false, reason: 'no_collector' });
        return false;
      }
      handleRequestTabEvaluation(tabId, Boolean(request.forceVision))
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, reason: 'no_collector', error: String(err) }));
      return true;
    }

    if (message.type === 'CHECK_MODEL_UPDATE') {
      syncModelWithBackend(true)
        .then((status) => sendResponse({
          success: true,
          status,
          runtimeState: getLocalRuntimeState(),
        }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'CHECK_FOR_UPDATE') {
      ensureLocalInitialization()
        .then(() => negotiateGatewayCapabilities(true))
        .then(() => modelSyncManager.checkForUpdate(engine))
        .then((updateInfo) => sendResponse({
          success: true,
          updateInfo,
          runtimeState: getLocalRuntimeState(),
        }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'DOWNLOAD_LATEST_MODEL') {
      downloadLatestModel()
        .then((result) => sendResponse({ success: true, ...result, runtimeState: getLocalRuntimeState() }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'GET_MODEL_STATUS') {
      modelStorage
        .getSyncStatus()
        .then((status) => {
          const activeVersion = engine.isReady() ? engine.getActiveVersion() : '0.0.0';
          const activeMetadata = engine.isReady() ? engine.getActiveMetadata() : null;
          const storedMatchesActive = Boolean(
            status &&
            engine.isReady() &&
            status.currentVersion === activeVersion &&
            (status.activeMetadata?.sha256 ?? null) === (activeMetadata?.sha256 ?? null)
          );
          const visibleStatus: ModelSyncStatus = storedMatchesActive && status
            ? {
                ...status,
                currentVersion: activeVersion,
                modelSource: engine.getActiveSource(),
                activeMetadata,
              }
            : {
                currentVersion: activeVersion,
                latestAvailableVersion: activeVersion,
                isLatest: false,
                lastSyncAttempt: status?.lastSyncAttempt ?? new Date().toISOString(),
                syncState: 'OFFLINE_FALLBACK',
                backendReachable: false,
                modelSource: engine.getActiveSource(),
                activeMetadata,
              };
          sendResponse({ success: true, status: visibleStatus, runtimeState: getLocalRuntimeState() });
        })
        .catch((err) => {
          const activeVersion = engine.isReady() ? engine.getActiveVersion() : '0.0.0';
          const activeMetadata = engine.isReady() ? engine.getActiveMetadata() : null;
          const fallbackStatus: ModelSyncStatus = {
            currentVersion: activeVersion,
            latestAvailableVersion: activeVersion,
            isLatest: false,
            lastSyncAttempt: new Date().toISOString(),
            syncState: 'SYNC_ERROR',
            backendReachable: false,
            modelSource: engine.getActiveSource(),
            activeMetadata,
          };
          sendResponse({
            success: false,
            error: String(err),
            status: fallbackStatus,
            runtimeState: getLocalRuntimeState(),
          });
        });
      return true;
    }

    if (message.type === 'GET_INSPECTIONS') {
      sqliteStorage
        .getRecentInspections(10)
        .then((history) => sendResponse({ success: true, history }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'UPDATE_CONFIG') {
      if (message.config?.backendUrl) {
        currentBackendUrl = String(message.config.backendUrl).replace(/\/+$/, '');
        gatewayCapabilitiesCache = null;
        modelSyncManager.setGatewayCapabilities(null);
        modelSyncManager.setBackendUrl(currentBackendUrl);
        extensionUpdateManager.setBackendUrl(currentBackendUrl);
        console.log(`[PhishGuard] Backend URL updated to: ${currentBackendUrl}`);
        syncModelWithBackend(true)
          .catch((e) => console.warn('[PhishGuard] Sync on config update error:', e));
        extensionUpdateManager.checkForExtensionUpdate({ interactive: false }).catch(() => {});
        sendResponse({ success: true, backendUrl: currentBackendUrl });
      } else {
        sendResponse({ success: false, error: 'No backendUrl specified in config' });
      }
      return true;
    }

    if (message.type === 'GET_CONFIG') {
      sendResponse({
        success: true,
        config: {
          backendUrl: currentBackendUrl,
        },
      });
      return true;
    }

    if (message.type === 'CHECK_EXTENSION_UPDATE') {
      extensionUpdateManager
        .checkForExtensionUpdate({ interactive: Boolean(message.interactive) })
        .then((status) => sendResponse({ success: true, status }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'GET_EXTENSION_UPDATE_STATUS') {
      const cached = extensionUpdateManager.getLastStatus();
      if (cached) {
        sendResponse({ success: true, status: cached });
      } else {
        extensionUpdateManager
          .checkForExtensionUpdate({ interactive: false })
          .then((status) => sendResponse({ success: true, status }))
          .catch((err) => sendResponse({ success: false, error: String(err) }));
      }
      return true;
    }

    if (message.type === 'INSTALL_EXTENSION_UPDATE') {
      extensionUpdateManager
        .installExtensionUpdate()
        .then((result) => sendResponse({ ...result }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'GET_EXTENSION_VERSIONS') {
      extensionUpdateManager
        .getAvailableVersions()
        .then((list) => sendResponse({ success: true, list }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'INSTALL_EXTENSION_VERSION') {
      extensionUpdateManager
        .installVersion(message.version, message.format || 'crx')
        .then((result) => sendResponse({ ...result }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'TRIGGER_CLOUD_ESCALATION') {
      handleManualEscalation(
        message.tabId ?? sender.tab?.id,
        message.includeScreenshot === true,
        message.snapshot
      )
        .then((verdict) => sendResponse({ success: true, verdict }))
        .catch((err) => {
          console.warn('[PhishGuard] Manual cloud escalation failed:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true;
    }

    if (message.type === 'CLEAR_CLOUD_VERDICT') {
      const tabId = Number(message.tabId ?? sender.tab?.id);
      if (!Number.isInteger(tabId)) {
        sendResponse({ success: false, error: 'A tab ID is required' });
        return false;
      }
      clearTabCloudVerdict(tabId, message.snapshot)
        .then((cleared) => sendResponse({ success: true, cleared }))
        .catch(() => sendResponse({ success: false, error: 'Cloud verdict could not be cleared' }));
      return true;
    }

    if (message.type === 'GET_WARNING_CONFIG') {
      getWarningConfig()
        .then((config) => sendResponse({ success: true, config }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'UPDATE_WARNING_CONFIG') {
      const updates: Record<string, unknown> = {};
      if (message.config?.warningType) updates.warningType = message.config.warningType;
      if (message.config?.snoozeDurationMinutes) updates.snoozeDurationMinutes = message.config.snoozeDurationMinutes;
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local
          .set(updates)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'ACKNOWLEDGE_DOMAIN') {
      acknowledgeDomain(message.domain)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'SNOOZE_DOMAIN') {
      snoozeDomain(message.domain, message.durationMinutes)
        .then((until) => sendResponse({ success: true, snoozedUntil: until }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'CLEAR_DOMAIN_SUPPRESSION') {
      clearDomainSuppression(message.domain)
        .then(() => {
          if (sender.tab?.id && typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
            chrome.tabs.sendMessage(sender.tab.id, { type: 'CLEAR_SUPPRESSION_DIRECTIVE' });
          }
          sendResponse({ success: true });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'CLEAR_ALL_SUPPRESSIONS') {
      clearAllSuppressions()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message.type === 'CHECK_DOMAIN_SUPPRESSION') {
      getWarningConfig()
        .then((cfg) => {
          const dom = message.domain;
          const isAck = Boolean(cfg.acknowledgedDomains[dom]);
          const snoozeUntil = cfg.snoozedDomains[dom] || 0;
          const isSnoozed = snoozeUntil > Date.now();
          const remainingMinutes = isSnoozed ? Math.max(1, Math.round((snoozeUntil - Date.now()) / 60000)) : 0;
          sendResponse({
            success: true,
            isSuppressed: isAck || isSnoozed,
            isAcknowledged: isAck,
            isSnoozed,
            snoozeUntil,
            remainingMinutes,
            warningType: cfg.warningType,
          });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    return false;
  });
}


export async function getWarningConfig(): Promise<{
  warningType: WarningPresentationType;
  snoozeDurationMinutes: number;
  snoozedDomains: Record<string, number>;
  acknowledgedDomains: Record<string, number>;
}> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return {
      warningType: 'smart',
      snoozeDurationMinutes: 15,
      snoozedDomains: {},
      acknowledgedDomains: {},
    };
  }
  const stored = await chrome.storage.local.get([
    'warningType',
    'snoozeDurationMinutes',
    'snoozedDomains',
    'acknowledgedDomains',
  ]);
  return {
    warningType: (stored.warningType as WarningPresentationType) || 'smart',
    snoozeDurationMinutes: typeof stored.snoozeDurationMinutes === 'number' ? stored.snoozeDurationMinutes : 15,
    snoozedDomains: (stored.snoozedDomains as Record<string, number>) || {},
    acknowledgedDomains: (stored.acknowledgedDomains as Record<string, number>) || {},
  };
}

export async function isDomainSuppressed(domain: string): Promise<boolean> {
  if (!domain) return false;
  const cfg = await getWarningConfig();
  if (cfg.acknowledgedDomains[domain]) {
    return true;
  }
  const snoozeUntil = cfg.snoozedDomains[domain];
  if (snoozeUntil && Date.now() < snoozeUntil) {
    return true;
  }
  return false;
}

export async function acknowledgeDomain(domain: string): Promise<void> {
  if (!domain || typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const cfg = await getWarningConfig();
  cfg.acknowledgedDomains[domain] = Date.now();
  await chrome.storage.local.set({ acknowledgedDomains: cfg.acknowledgedDomains });
}

export async function snoozeDomain(domain: string, minutes?: number): Promise<number> {
  if (!domain || typeof chrome === 'undefined' || !chrome.storage?.local) return Date.now();
  const cfg = await getWarningConfig();
  const duration = minutes || cfg.snoozeDurationMinutes || 15;
  const snoozeUntil = Date.now() + duration * 60 * 1000;
  cfg.snoozedDomains[domain] = snoozeUntil;
  await chrome.storage.local.set({ snoozedDomains: cfg.snoozedDomains });
  return snoozeUntil;
}

export async function clearDomainSuppression(domain: string): Promise<void> {
  if (!domain || typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const cfg = await getWarningConfig();
  delete cfg.acknowledgedDomains[domain];
  delete cfg.snoozedDomains[domain];
  await chrome.storage.local.set({
    acknowledgedDomains: cfg.acknowledgedDomains,
    snoozedDomains: cfg.snoozedDomains,
  });
}

export async function clearAllSuppressions(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set({
    acknowledgedDomains: {},
    snoozedDomains: {},
  });
}

const NOTIFICATION_ORIGIN_PREFIX = 'notificationOrigin:';
const NotificationOriginSchema = z.object({
  tabId: z.number().int().nonnegative(),
  pageSessionId: z.string().min(1),
  navigationGeneration: z.number().int().nonnegative(),
  url: z.string().url(),
  snoozeDurationMinutes: z.number().finite().positive(),
}).strict();
type NotificationOrigin = z.infer<typeof NotificationOriginSchema>;

async function getCurrentNotificationTab(origin: NotificationOrigin): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.get || !chrome.tabs?.sendMessage) return null;
  const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    try {
      chrome.tabs.get(origin.tabId, (value) => {
        resolve(chrome.runtime?.lastError ? null : value ?? null);
      });
    } catch {
      resolve(null);
    }
  });
  if (!tab || tab.id !== origin.tabId || tab.url !== origin.url) return null;
  const identity = await requestPageIdentity(origin.tabId);
  if (
    !identity ||
    identity.pageSessionId !== origin.pageSessionId ||
    identity.navigationGeneration !== origin.navigationGeneration ||
    identity.url !== origin.url
  ) {
    return null;
  }
  return tab;
}

function notificationOriginKey(notifId: string): string {
  return `${NOTIFICATION_ORIGIN_PREFIX}${notifId}`;
}

export async function triggerDesktopNotification(
  domain: string,
  brand?: string | null,
  reasons?: string[],
  snoozeMinutes: number = 15,
  originInput?: Omit<NotificationOrigin, 'snoozeDurationMinutes'>
): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.notifications?.create) return;
  const area = getSessionStorageArea();
  const parsedOrigin = NotificationOriginSchema.safeParse({
    ...originInput,
    snoozeDurationMinutes: snoozeMinutes,
  });
  if (!area || !parsedOrigin.success) return;
  const origin = parsedOrigin.data;
  let originHost: string;
  try {
    originHost = new URL(origin.url).hostname;
  } catch {
    return;
  }
  if (originHost !== domain || !(await getCurrentNotificationTab(origin))) return;
  const notifId = `phishguard-block-${domain}-${Date.now()}`;
  const storageKey = notificationOriginKey(notifId);
  const brandMsg = brand ? `Suspected ${brand} impersonation` : 'Deceptive website detected';
  const reasonMsg = reasons && reasons.length > 0 ? reasons[0] : 'High behavioral anomaly detected';

  try {
    await area.set({ [storageKey]: origin });
    if (!(await getCurrentNotificationTab(origin))) {
      await area.remove(storageKey);
      return;
    }
    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'PhishGuard: Deceptive Site Blocked',
      message: `${brandMsg} on ${domain}. ${reasonMsg}`,
      contextMessage: 'PhishGuard Threat Defense',
      priority: 2,
      requireInteraction: true,
      buttons: [
        { title: 'Leave Site (Safe)' },
        { title: `Snooze (${snoozeMinutes}m)` },
      ],
    });
  } catch {
    await area.remove(storageKey).catch(() => {});
  }
}

export async function handleDesktopNotificationButtonClick(notifId: string, btnIdx: number): Promise<void> {
  if (!notifId.startsWith('phishguard-block-')) return;
  const legacyIdParts = notifId.replace('phishguard-block-', '').split('-');
  legacyIdParts.pop(); // Remove timestamp
  const area = getSessionStorageArea();
  const storageKey = notificationOriginKey(notifId);
  try {
    if (!area || legacyIdParts.length === 0) return;
    const stored = await area.get(storageKey);
    const parsed = NotificationOriginSchema.safeParse(stored[storageKey]);
    if (!parsed.success) return;
    const origin = parsed.data;
    if (!(await getCurrentNotificationTab(origin))) return;
    if (btnIdx === 0) {
      // Leave Site
      if (chrome.tabs?.update) {
        await chrome.tabs.update(origin.tabId, { url: 'about:blank' });
      }
    } else if (btnIdx === 1) {
      // Snooze
      const domain = new URL(origin.url).hostname;
      await snoozeDomain(domain, origin.snoozeDurationMinutes);
    }
  } finally {
    await area?.remove(storageKey).catch(() => {});
    if (typeof chrome !== 'undefined') chrome.notifications?.clear(notifId);
  }
}

if (typeof chrome !== 'undefined' && chrome.notifications?.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    await handleDesktopNotificationButtonClick(notifId, btnIdx);
  });
}

if (typeof chrome !== 'undefined' && chrome.notifications?.onClosed) {
  chrome.notifications.onClosed.addListener(async (notifId) => {
    const area = getSessionStorageArea();
    if (area && notifId.startsWith('phishguard-block-')) {
      await area.remove(notificationOriginKey(notifId)).catch(() => {});
    }
  });
}

interface CachedTabVision {
  pageSessionId: string;
  navigationGeneration: number;
  url: string;
  modelHash: string | null;
  capturedAt: number;
  tensor: Float32Array;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export const tabVisionCache = new Map<number, CachedTabVision>();
const TAB_ANALYSIS_STORAGE_PREFIX = 'tabAnalysis:';

function clearTabVisionCache(tabId: number): void {
  const cached = tabVisionCache.get(tabId);
  if (cached) clearTimeout(cached.expiryTimer);
  tabVisionCache.delete(tabId);
}

function clearAllTabVisionCache(): void {
  for (const cached of tabVisionCache.values()) clearTimeout(cached.expiryTimer);
  tabVisionCache.clear();
}

/**
 * A cached frame is only reusable while it belongs to the exact page the
 * evaluation describes and was produced by the active model recently enough.
 */
function freshCachedVisionFrame(
  tabId: number,
  envelope: PageEvaluationEnvelope,
  modelHash: string | null
): CachedTabVision | null {
  const frame = tabVisionCache.get(tabId);
  if (
    frame &&
    frame.pageSessionId === envelope.pageSessionId &&
    frame.navigationGeneration === envelope.navigationGeneration &&
    frame.url === envelope.url &&
    frame.modelHash === modelHash &&
    Date.now() - frame.capturedAt <= 5000
  ) {
    return frame;
  }
  return null;
}

interface AsyncSessionStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface TabAnalysisReference {
  pageSessionId: string;
  navigationGeneration: number;
  evaluationGeneration: number;
  telemetryId: string;
  url: string;
  warningVisible: boolean;
  topologyScanComplete: boolean;
}

function getSessionStorageArea(): AsyncSessionStorageArea | undefined {
  if (typeof chrome === 'undefined' || !chrome.storage) return undefined;
  return (chrome.storage as unknown as { session?: AsyncSessionStorageArea }).session;
}

/**
 * Tabs whose document already had the packaged content script injected by the
 * missing-collector recovery path. Cleared on document/navigation invalidation
 * so a fresh page may be injected again.
 */
const collectorRecoveredTabs = new Set<number>();

/**
 * Tabs where the collector-recovery injection itself was rejected (e.g. Web
 * Store, extension galleries, PDF viewer). Cleared on document/navigation
 * invalidation alongside collectorRecoveredTabs.
 */
const collectorInjectionRestrictedTabs = new Set<number>();

function isMissingReceiverError(error: unknown): boolean {
  const text = typeof error === 'string'
    ? error
    : (error as { message?: string } | null)?.message ?? '';
  return /Receiving end does not exist|Could not establish connection/i.test(text);
}

function sendTabMessage(tabId: number, message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime?.lastError) {
          resolve({ error: chrome.runtime.lastError.message ?? 'Message failed' });
          return;
        }
        resolve(response);
      });
    } catch (error) {
      resolve({ error: String(error) });
    }
  });
}

/**
 * Deliver a message to a tab, recovering a missing collector once: when the
 * page has no content-script listener, inject the actual packaged
 * `dist/content.js` a single time and retry the message once.
 */
async function sendTabMessageWithCollectorRecovery(
  tabId: number,
  message: Record<string, unknown>
): Promise<unknown> {
  let response = await sendTabMessage(tabId, message);
  if (
    isRecord(response) &&
    isMissingReceiverError(response.error) &&
    !collectorRecoveredTabs.has(tabId) &&
    typeof chrome !== 'undefined' &&
    chrome.scripting?.executeScript
  ) {
    collectorRecoveredTabs.add(tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dist/content.js'],
      });
      response = await sendTabMessage(tabId, message);
    } catch {
      // Restricted pages (e.g. Web Store) reject injection
      collectorInjectionRestrictedTabs.add(tabId);
    }
  }
  return isRecord(response) && 'error' in response && response.error !== undefined
    ? null
    : response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Popup-initiated evaluation request. The background owns collector
 * injection so there is exactly one once-per-document recovery guard.
 * Restricted is reported for non-http(s) pages and for injection rejections
 * (e.g. Web Store); no_collector when the page still has no listener after
 * the single injection retry.
 */
async function handleRequestTabEvaluation(
  tabId: number,
  forceVision: boolean
): Promise<{ success: boolean; reason?: 'restricted' | 'no_collector'; response?: unknown }> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
    return { success: false, reason: 'no_collector' };
  }
  let tabUrl = '';
  try {
    const tab = chrome.tabs?.get ? await chrome.tabs.get(tabId) : undefined;
    tabUrl = typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    return { success: false, reason: 'restricted' };
  }
  if (!/^https?:\/\//i.test(tabUrl)) {
    return { success: false, reason: 'restricted' };
  }
  const response = await sendTabMessageWithCollectorRecovery(tabId, {
    type: 'REQUEST_TELEMETRY_EVALUATION',
    forceVision,
  });
  if (response === null) {
    return {
      success: false,
      reason: collectorInjectionRestrictedTabs.has(tabId) ? 'restricted' : 'no_collector',
    };
  }
  return { success: true, response };
}

function requestPageIdentity(tabId: number): Promise<ReturnType<typeof PageIdentitySchema.parse> | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return Promise.resolve(null);
  return sendTabMessageWithCollectorRecovery(tabId, { type: 'GET_PAGE_IDENTITY' })
    .then((response) => {
      const parsed = PageIdentitySchema.safeParse(response);
      return parsed.success ? parsed.data : null;
    });
}

/**
 * Broadcast a per-tab analysis progress update so the popup can render an
 * explicit pipeline state for the in-flight evaluation. Popup-side guards
 * discard updates whose tab/url/generation do not match its current request.
 */
function broadcastAnalysisProgress(
  tabId: number,
  envelope: PageEvaluationEnvelope,
  phase: 'collecting' | 'capturing' | 'analyzing' | 'completed',
  analysis?: Record<string, unknown>
): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    chrome.runtime.sendMessage(
      {
        type: 'ANALYSIS_PROGRESS',
        tabId,
        url: envelope.url,
        pageSessionId: envelope.pageSessionId,
        navigationGeneration: envelope.navigationGeneration,
        evaluationGeneration: envelope.evaluationGeneration,
        phase,
        ...(analysis ? { analysis } : {}),
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // No popup listening
  }
}

function samePageIdentity(
  identity: ReturnType<typeof PageIdentitySchema.parse>,
  expected: PageEvaluationEnvelope
): boolean {
  return identity.pageSessionId === expected.pageSessionId &&
    identity.navigationGeneration === expected.navigationGeneration &&
    identity.evaluationGeneration === expected.evaluationGeneration &&
    identity.url === expected.url;
}

function sameEvaluationIdentity(
  identity: ReturnType<typeof PageIdentitySchema.parse>,
  expected: PageEvaluationEnvelope
): boolean {
  return samePageIdentity(identity, expected) &&
    identity.warningVisible === expected.warningVisible;
}

function sameSnapshotPageIdentity(
  identity: ReturnType<typeof PageIdentitySchema.parse>,
  snapshot: TabAnalysisSnapshot
): boolean {
  return identity.pageSessionId === snapshot.pageSessionId &&
    identity.navigationGeneration === snapshot.navigationGeneration &&
    identity.evaluationGeneration === snapshot.evaluationGeneration &&
    identity.url === snapshot.url;
}

async function isCurrentContentEvaluation(
  tabId: number,
  envelope: PageEvaluationEnvelope
): Promise<boolean> {
  if (envelope.pageSessionId.startsWith('legacy-tab-')) {
    return isTabUrlCurrent(tabId, envelope.url);
  }
  let identity = await requestPageIdentity(tabId);
  return !!identity && sameEvaluationIdentity(identity, envelope);
}

function getMessageEnvelope(
  message: Record<string, unknown>,
  payload: InteractionTelemetryPayload,
  tabId?: number
): PageEvaluationEnvelope | null {
  if (
    typeof message.pageSessionId === 'string' &&
    message.pageSessionId.length > 0 &&
    typeof message.navigationGeneration === 'number' &&
    typeof message.evaluationGeneration === 'number' &&
    typeof message.url === 'string' &&
    typeof message.warningVisible === 'boolean' &&
    typeof message.topologyScanComplete === 'boolean' &&
    message.url === payload.url &&
    Number.isInteger(message.navigationGeneration) &&
    Number.isInteger(message.evaluationGeneration) &&
    message.navigationGeneration >= 0 &&
    message.evaluationGeneration > 0
  ) {
    return {
      pageSessionId: message.pageSessionId,
      navigationGeneration: message.navigationGeneration,
      evaluationGeneration: message.evaluationGeneration,
      url: message.url,
      warningVisible: message.warningVisible,
      topologyScanComplete: message.topologyScanComplete,
    };
  }
  if (tabId === undefined || payload.url.length === 0) return null;
  let legacyPage = legacyPageContexts.get(tabId);
  if (!legacyPage) {
    legacyPage = {
      url: payload.url,
      pageSessionId: `legacy-tab-${tabId}-${crypto.randomUUID()}`,
      navigationGeneration: 0,
    };
  } else if (legacyPage.url !== payload.url) {
    legacyPage = {
      ...legacyPage,
      url: payload.url,
      navigationGeneration: legacyPage.navigationGeneration + 1,
    };
  }
  legacyPageContexts.set(tabId, legacyPage);
  const evaluationGeneration = (legacyEvaluationGenerations.get(tabId) ?? 0) + 1;
  legacyEvaluationGenerations.set(tabId, evaluationGeneration);
  return {
    pageSessionId: legacyPage.pageSessionId,
    navigationGeneration: legacyPage.navigationGeneration,
    evaluationGeneration,
    url: payload.url,
    warningVisible: false,
    topologyScanComplete: true,
  };
}

function parseAutomaticTelemetry(value: unknown): InteractionTelemetryPayload {
  const parsed = InteractionTelemetryPayloadSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid telemetry payload');
  const payload = { ...parsed.data };
  delete payload.viewportCapture;
  return payload;
}

async function persistTabAnalysisSnapshot(snapshot: TabAnalysisSnapshot): Promise<void> {
  const area = getSessionStorageArea();
  if (!area || !tabAnalysisStore.isCurrentSnapshot(snapshot)) return;
  const key = `${TAB_ANALYSIS_STORAGE_PREFIX}${snapshot.tabId}`;
  await tabSessionStorageQueue.run(snapshot.tabId, async () => {
    if (!tabAnalysisStore.isCurrentSnapshot(snapshot)) return;
    await area.set({ [key]: snapshot });
    if (!tabAnalysisStore.isCurrentSnapshot(snapshot)) await area.remove(key);
  });
}

async function getTabAnalysisSnapshot(
  tabId: number,
  expectedUrl?: string
): Promise<TabAnalysisSnapshot | null> {
  let identity = await requestPageIdentity(tabId);
  if (!identity || (expectedUrl !== undefined && expectedUrl !== identity.url)) return null;
  const cached = tabAnalysisStore.get(tabId, identity.url);
  if (cached && sameSnapshotPageIdentity(identity, cached)) return cached;
  if (tabAnalysisStore.hasTab(tabId)) return null;
  const area = getSessionStorageArea();
  if (!area) return null;
  const key = `${TAB_ANALYSIS_STORAGE_PREFIX}${tabId}`;
  await tabSessionStorageQueue.flush(tabId);
  const stored = await tabSessionStorageQueue.run(tabId, () => area.get(key));
  const identityAfterRead = await requestPageIdentity(tabId);
  if (!identityAfterRead ||
    !samePageIdentity(identityAfterRead, identity)) {
    return null;
  }
  const parsed = TabAnalysisSnapshotSchema.safeParse(stored[key]);
  if (!parsed.success || parsed.data.tabId !== tabId ||
    parsed.data.url !== identityAfterRead.url ||
    !sameSnapshotPageIdentity(identityAfterRead, parsed.data)) {
    return null;
  }
  return tabAnalysisStore.restore(parsed.data, identityAfterRead);
}

/**
 * Display variant of getTabAnalysisSnapshot: returns the strict current
 * snapshot exactly when the strict accessor would, plus the last completed
 * same-page snapshot (current: false) while a newer evaluation is pending.
 * The persisted-session restore path is preserved for the strict case.
 */
async function getTabAnalysisForDisplay(
  tabId: number,
  expectedUrl?: string
): Promise<{ snapshot: TabAnalysisSnapshot; current: boolean; evaluationPending: boolean } | null> {
  const identity = await requestPageIdentity(tabId);
  if (!identity || (expectedUrl !== undefined && expectedUrl !== identity.url)) return null;
  const activeModelHash = engine.getActiveMetadata()?.sha256 ?? null;
  const display = tabAnalysisStore.getForDisplay(tabId, identity.url, activeModelHash);
  if (display?.current) return display;
  // Live per-tab state outranks persisted session storage: either there is a
  // displayable previous snapshot, or a pending evaluation means nothing
  // older should be shown.
  if (tabAnalysisStore.hasTab(tabId)) return display;
  const snapshot = await getTabAnalysisSnapshot(tabId, identity.url);
  return snapshot ? { snapshot, current: true, evaluationPending: false } : null;
}

function invalidateTabAnalysis(tabId: number, kind: 'document' | 'navigation' | 'closed' = 'document'): void {
  if (kind === 'closed') {
    legacyPageContexts.delete(tabId);
    tabAnalysisStore.forget(tabId);
  } else if (kind === 'document') {
    legacyPageContexts.delete(tabId);
    tabAnalysisStore.invalidate(tabId);
  } else {
    tabAnalysisStore.invalidateNavigation(tabId);
  }
  collectorRecoveredTabs.delete(tabId);
  collectorInjectionRestrictedTabs.delete(tabId);
  clearTabVisionCache(tabId);
  const area = getSessionStorageArea();
  if (area) {
    void tabSessionStorageQueue.run(tabId, () => area.remove(`${TAB_ANALYSIS_STORAGE_PREFIX}${tabId}`))
      .catch(() => {});
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    invalidateTabAnalysis(tabId, 'closed');
  });
}

export function handleTabUpdated(
  tabId: number,
  changeInfo: { url?: string; status?: string }
): void {
  if (changeInfo.url) {
    // A URL report wins over the status branch: same-document SPA navigations
    // arrive as {url, status:'loading'} and must not retire the still-live
    // page session. For a real document replacement the stale session is
    // harmless — the next begin() retires it and the per-evaluation URL
    // checks drop any late messages.
    invalidateTabAnalysis(tabId, 'navigation');
    // Nudge the live collector to resync its session in case its own
    // navigation detectors missed the change.
    if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'PAGE_URL_CHANGED', url: changeInfo.url }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // No collector listening on this page.
      }
    }
  } else if (changeInfo.status === 'loading') {
    // If the active tab navigated away to a different URL, reset latestAnalysis so popup does not show stale data
    invalidateTabAnalysis(tabId, 'document');
  }
}

// Invalidate tabVisionCache and stale latestAnalysis when a tab redirects or navigates to a new URL
if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    handleTabUpdated(tabId, changeInfo);
  });
}

export async function handleTelemetryEvaluation(
  payloadInput: unknown,
  tabId?: number,
  forceVision: boolean = false,
  evaluationEnvelope?: PageEvaluationEnvelope,
  visionRecoveryAttempt: number = 0,
  displayedBrands: string[] = []
): Promise<Record<string, unknown>> {
  let payload: InteractionTelemetryPayload;
  try {
    payload = parseAutomaticTelemetry(payloadInput);
  } catch {
    throw new Error('Invalid telemetry payload');
  }
  if (tabId === undefined) return { stale: true };
  const recoveryAttempt = Number.isInteger(visionRecoveryAttempt) &&
    visionRecoveryAttempt >= 0 &&
    visionRecoveryAttempt <= 2
    ? visionRecoveryAttempt
    : 0;
  const envelope = evaluationEnvelope ?? getMessageEnvelope({}, payload, tabId);
  if (!envelope || envelope.url !== payload.url) return { stale: true };
  if (evaluationEnvelope && !(await isCurrentContentEvaluation(tabId, envelope))) return { stale: true };
  await ensureLocalInitialization();
  if (envelope.url !== payload.url ||
    !(await isCurrentContentEvaluation(tabId, envelope)) ||
    !(await isTabUrlCurrent(tabId, envelope.url))) {
    return { stale: true };
  }
  if (!tabAnalysisStore.begin(tabId, envelope)) {
    return { stale: true };
  }
  const result = await tabEvaluationQueue.enqueue(tabId, () =>
    evaluateTabTelemetry(payload, tabId, forceVision, envelope, recoveryAttempt, displayedBrands)
  );
  return result ?? { stale: true };
}

async function evaluateTabTelemetry(
  payload: InteractionTelemetryPayload,
  tabId: number,
  forceVision: boolean,
  envelope: PageEvaluationEnvelope,
  visionRecoveryAttempt: number,
  displayedBrands: string[] = []
): Promise<Record<string, unknown>> {
  if (!tabAnalysisStore.isCurrent(tabId, envelope) ||
    !(await isCurrentContentEvaluation(tabId, envelope))) {
    return { stale: true };
  }
  broadcastAnalysisProgress(tabId, envelope, 'collecting');
  const modelHashAtEvaluationStart = engine.getActiveMetadata()?.sha256 ?? null;
  const cached = tabVisionCache.get(tabId);
  if (cached && !freshCachedVisionFrame(tabId, envelope, modelHashAtEvaluationStart)) {
    clearTabVisionCache(tabId);
  }
  let visualTensor: Float32Array | null = null;
  let visionUnavailableReason: VisionUnavailableReason | null = 'missing_api';
  if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== payload.url) return { stale: true };
      if (envelope.warningVisible) {
        const preWarningFrame = freshCachedVisionFrame(tabId, envelope, modelHashAtEvaluationStart);
        if (preWarningFrame) {
          visualTensor = preWarningFrame.tensor;
          visionUnavailableReason = null;
        } else {
          visionUnavailableReason = 'warning_visible_no_fresh_frame';
        }
      } else if (tab.windowId !== undefined) {
        broadcastAnalysisProgress(tabId, envelope, 'capturing');
        const captured = await captureVisualTensorWithStatus(
          tabId,
          tab.windowId,
          forceVision,
          envelope.url
        );
        if (captured.status === 'captured' && captured.tensor && captured.capturedAt !== null) {
          visualTensor = captured.tensor;
          visionUnavailableReason = null;
          clearTabVisionCache(tabId);
          const expiryTimer = setTimeout(() => {
            if (tabVisionCache.get(tabId) === frame) tabVisionCache.delete(tabId);
          }, 5000);
          const frame: CachedTabVision = {
            pageSessionId: envelope.pageSessionId,
            navigationGeneration: envelope.navigationGeneration,
            url: envelope.url,
            modelHash: modelHashAtEvaluationStart,
            capturedAt: captured.capturedAt,
            tensor: captured.tensor,
            expiryTimer,
          };
          (expiryTimer as unknown as { unref?: () => void }).unref?.();
          tabVisionCache.set(tabId, frame);
        // Preserve verified vision evaluation across rate-limited telemetry
        // updates and transient capture failures for the same tab/domain by
        // reusing a recent same-page frame.
        } else if (
          captured.status === 'rate_limited' ||
          (captured.status === 'unavailable' &&
            (captured.reason === 'capture_api_failure' ||
              captured.reason === 'decode_canvas_failure' ||
              captured.reason === 'unfocused_window'))
        ) {
          const freshFrame = freshCachedVisionFrame(tabId, envelope, modelHashAtEvaluationStart);
          if (freshFrame) {
            visualTensor = freshFrame.tensor;
            visionUnavailableReason = null;
          } else {
            visionUnavailableReason = captured.reason;
          }
        } else {
          visionUnavailableReason = captured.reason;
        }
      } else {
        visionUnavailableReason = 'inactive_tab';
      }
    } catch {
      visualTensor = null;
      visionUnavailableReason = 'capture_api_failure';
    }
  }
  if (!tabAnalysisStore.isCurrent(tabId, envelope) ||
    !(await isCurrentContentEvaluation(tabId, envelope))) {
    return { stale: true };
  }
  const activeModelHash = engine.getActiveMetadata()?.sha256 ?? null;
  const activeFrame = tabVisionCache.get(tabId);
  if (activeModelHash !== modelHashAtEvaluationStart) {
    clearTabVisionCache(tabId);
    visualTensor = null;
    visionUnavailableReason = 'model_changed';
  } else if (activeFrame && activeFrame.modelHash !== activeModelHash) {
    clearTabVisionCache(tabId);
    visualTensor = null;
    visionUnavailableReason = 'model_changed';
  }
  broadcastAnalysisProgress(tabId, envelope, 'analyzing');
  const { result: clientResult, breakdown } = await engine.predictDetailed(
    payload,
    visualTensor,
    {
      topologyScanComplete: envelope.topologyScanComplete,
      visionUnavailableReason,
      visionRecoveryAttempt,
      displayedBrands,
    }
  );
  visualTensor = null;
  if (!tabAnalysisStore.isCurrent(tabId, envelope) ||
    !(await isCurrentContentEvaluation(tabId, envelope)) ||
    !(await isTabUrlCurrent(tabId, envelope.url))) {
    return { stale: true };
  }

  const analysisRecord = {
    telemetryId: payload.telemetryId,
    url: payload.url,
    domain: payload.domain,
    pageSessionId: envelope.pageSessionId,
    navigationGeneration: envelope.navigationGeneration,
    evaluationGeneration: envelope.evaluationGeneration,
    warningVisible: envelope.warningVisible,
    topologyScanComplete: envelope.topologyScanComplete,
    riskScore: clientResult.clientRiskScore,
    action: clientResult.routeAction,
    evaluatedAt: clientResult.evaluatedAt,
    modelVersion: clientResult.modelVersion,
    pointerSamples: payload.pointerSeries.length,
    keystrokeSamples: payload.keystrokes.length,
    domAnomalies: breakdown.page.anomalies,
    signals: breakdown,
    canEscalate: true,
    tabId: tabId,
  };

  const snapshot: TabAnalysisSnapshot = {
    tabId,
    pageSessionId: envelope.pageSessionId,
    navigationGeneration: envelope.navigationGeneration,
    evaluationGeneration: envelope.evaluationGeneration,
    url: envelope.url,
    warningVisible: envelope.warningVisible,
    topologyScanComplete: envelope.topologyScanComplete,
    telemetryId: payload.telemetryId,
    payload,
    analysis: analysisRecord,
    cloudVerdict: null,
    capturedAt: Date.now(),
  };
  if (!tabAnalysisStore.publish(snapshot)) return { stale: true };
  broadcastAnalysisProgress(tabId, envelope, 'completed', analysisRecord);
  await persistTabAnalysisSnapshot(snapshot);
  if (!tabAnalysisStore.isCurrentSnapshot(snapshot) ||
    !(await isCurrentContentEvaluation(tabId, envelope))) {
    return { stale: true };
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'TAB_ANALYSIS_UPDATED', tabId, url: envelope.url }, () => {
      void chrome.runtime.lastError;
    });
  }

  // 1. Persist inspection event to embedded SQLite frontend storage
  if (!tabAnalysisStore.isCurrentSnapshot(snapshot) ||
    !(await isCurrentContentEvaluation(tabId, envelope))) {
    return { stale: true };
  }
  sqliteStorage
    .recordInspection({
      url: payload.url,
      domain: payload.domain,
      riskScore: clientResult.clientRiskScore,
      action: clientResult.routeAction,
      modelVersion: clientResult.modelVersion || 'v1.0.0',
      pointerSamples: payload.pointerSeries.length,
      keystrokeSamples: payload.keystrokes.length,
      domAnomalies: breakdown.page.anomalies,
      timestamp: clientResult.evaluatedAt,
    })
    .catch((err) => console.warn('[PhishGuard-SQLite] Failed to record inspection history:', err));

  // 2. Cache latest score for popup UI and reset any old cloud verdict for the new evaluation
  if (clientResult.routeAction === 'BLOCK' && tabAnalysisStore.isCurrentSnapshot(snapshot)) {
    // 1. Check if domain warning is suppressed
    const isSuppressed = await isDomainSuppressed(payload.domain);
    if (!tabAnalysisStore.isCurrentSnapshot(snapshot) ||
      !(await isCurrentContentEvaluation(tabId, envelope)) ||
      !(await isTabUrlCurrent(tabId, envelope.url))) {
      return { stale: true };
    }
    if (isSuppressed) {
      console.log(`[PhishGuard] Threat warning suppressed for ${payload.domain}`);
      return analysisRecord;
    }

    const cfg = await getWarningConfig();
    if (!tabAnalysisStore.isCurrentSnapshot(snapshot) ||
      !(await isCurrentContentEvaluation(tabId, envelope)) ||
      !(await isTabUrlCurrent(tabId, envelope.url))) {
      return { stale: true };
    }
    const effectiveType = decideSmartWarningType(cfg.warningType, {
      hasCredentialField: payload.hasCredentialField,
      riskScore: clientResult.clientRiskScore,
      reasons: breakdown.fused.reasons,
    });

    if (effectiveType === 'notification') {
      await triggerDesktopNotification(
        payload.domain,
        null,
        breakdown.fused.reasons,
        cfg.snoozeDurationMinutes,
        {
          tabId,
          pageSessionId: snapshot.pageSessionId,
          navigationGeneration: snapshot.navigationGeneration,
          url: snapshot.url,
        }
      );
    }

    // Immediate on-device warning directive to tab
    if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage &&
      tabAnalysisStore.isCurrentSnapshot(snapshot)) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_PHISHING_BANNER',
        brand: null,
        reasons: breakdown.fused.reasons,
        warningType: cfg.warningType,
        effectiveType,
        hasCredentialField: payload.hasCredentialField,
        riskScore: clientResult.clientRiskScore,
        snoozeDurationMinutes: cfg.snoozeDurationMinutes,
        pageSessionId: envelope.pageSessionId,
        navigationGeneration: envelope.navigationGeneration,
        evaluationGeneration: envelope.evaluationGeneration,
        url: envelope.url,
      });
    }
    return analysisRecord;
  }

  // NOTE: Cloud escalation is NEVER automatic.
  // Ambiguous interactions display local results on-device.
  // Escalation to the cloud gateway is strictly voluntary and user-prompted.
  return analysisRecord;
}

async function isTabUrlCurrent(tabId: number, expectedUrl: string): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.get) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url === expectedUrl;
  } catch {
    return false;
  }
}

/**
 * Executes cloud escalation ONLY upon explicit user prompt/request.
 * Completely optional second-opinion verification from the cloud teacher model.
 */
export async function handleManualEscalation(
  tabId?: number,
  includeScreenshot = false,
  snapshotReference?: unknown
): Promise<CloudInferenceVerdict> {
  if (tabId === undefined || !Number.isInteger(tabId)) {
    throw new Error('An active tab is required for cloud verification.');
  }
  let snapshot = await getTabAnalysisSnapshot(tabId);
  if (!snapshot) {
    await requestTabEvaluation(tabId);
    snapshot = await getTabAnalysisSnapshot(tabId);
  }
  if (!snapshot) {
    throw new Error('No local interaction telemetry is available for this tab.');
  }
  let identity = await requestPageIdentity(tabId);
  if (!identity || !sameSnapshotPageIdentity(identity, snapshot)) {
    throw new Error('The inspected page changed. Inspect the current tab again before cloud verification.');
  }
  if (snapshotReference !== undefined && !matchesTabAnalysisReference(snapshot, snapshotReference)) {
    throw new Error('The inspected page changed. Inspect the current tab again before cloud verification.');
  }
  if (!tabAnalysisStore.isCurrentSnapshot(snapshot) ||
    !(await isTabUrlCurrent(tabId, snapshot.url))) {
    throw new Error('The inspected page changed. Inspect the current tab again before cloud verification.');
  }
  const capabilities = await negotiateGatewayCapabilities(true);
  const signals = snapshot.analysis.signals;
  const inputContract = signals.fused.inputContractIdentifier;
  if (
    !capabilities ||
    !capabilities.manualEscalation ||
    capabilities.telemetryEvidenceVersion !== 2 ||
    (inputContract !== null && !capabilities.modelInputContracts.includes(inputContract as 'student-v1' | 'student-v2'))
  ) {
    throw new Error('CLOUD_UPGRADE_REQUIRED');
  }

  const payload: EscalationPayload = {
    telemetryId: snapshot.telemetryId,
    url: snapshot.url,
    domain: snapshot.payload.domain,
    clientRiskScore: Number(snapshot.analysis.riskScore),
    hasCredentialField: snapshot.payload.hasCredentialField,
    ...(signals.fused.modelVersion ? { clientModelVersion: signals.fused.modelVersion } : {}),
    ...(signals.fused.modelHash ? { clientModelSha256: signals.fused.modelHash } : {}),
    ...(inputContract ? { clientInputContract: inputContract } : {}),
    mouseTrajectorySeries: snapshot.payload.pointerSeries,
    domElementsSummary: snapshot.payload.domEvents,
    keystrokesSummary: snapshot.payload.keystrokes,
    clientTimestamp: new Date().toISOString(),
  };

  if (includeScreenshot && !identity.warningVisible) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) {
        payload.screenshotBase64 = await captureScreenshotForUpload(tabId, tab.windowId, snapshot.url);
      }
    } catch {
      payload.screenshotBase64 = null;
    }
  } else if (includeScreenshot) {
    payload.screenshotBase64 = null;
  }
  if (
    !tabAnalysisStore.isCurrentSnapshot(snapshot) ||
    !(await isTabUrlCurrent(tabId, snapshot.url))
  ) {
    throw new Error('PAGE_SNAPSHOT_STALE');
  }
  identity = await requestPageIdentity(tabId);
  if (!identity || !sameSnapshotPageIdentity(identity, snapshot)) {
    throw new Error('PAGE_SNAPSHOT_STALE');
  }
  if (includeScreenshot && identity.warningVisible) payload.screenshotBase64 = null;

  let response: Response;
  try {
    response = await fetch(`${currentBackendUrl}/v1/escalate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_client_key',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ESCALATION_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('Cloud escalation gateway timed out');
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Cloud escalation gateway HTTP ${response.status}`);
  }
  let verdict: CloudInferenceVerdict;
  try {
    const parsed = CloudInferenceVerdictSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.telemetryId !== snapshot.telemetryId) {
      throw new Error('Invalid cloud verdict');
    }
    verdict = parsed.data;
  } catch {
    throw new Error('Invalid cloud verdict');
  }

  const currentIdentity = await requestPageIdentity(tabId);
  // Update popup state with cloud verdict
  if (
    !currentIdentity ||
    !sameSnapshotPageIdentity(currentIdentity, snapshot) ||
    !tabAnalysisStore.isCurrentSnapshot(snapshot) ||
    !tabAnalysisStore.attachCloudVerdict(snapshot, verdict)
  ) {
    throw new Error('PAGE_SNAPSHOT_STALE');
  }
  const updatedSnapshot = tabAnalysisStore.get(tabId, snapshot.url);
  if (!updatedSnapshot) throw new Error('PAGE_SNAPSHOT_STALE');
  await persistTabAnalysisSnapshot(updatedSnapshot);
  const identityAfterPersist = await requestPageIdentity(tabId);
  if (
    !identityAfterPersist ||
    !sameSnapshotPageIdentity(identityAfterPersist, updatedSnapshot) ||
    !tabAnalysisStore.isCurrentSnapshot(updatedSnapshot)
  ) {
    if (tabAnalysisStore.isCurrentSnapshot(updatedSnapshot)) invalidateTabAnalysis(tabId);
    throw new Error('PAGE_SNAPSHOT_STALE');
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'TAB_ANALYSIS_UPDATED', tabId, url: snapshot.url }, () => {
      void chrome.runtime.lastError;
    });
  }

  if (
    verdict.actionOverride === 'BLOCK' &&
    !currentIdentity.warningVisible &&
    tabAnalysisStore.isCurrentSnapshot(updatedSnapshot) &&
    typeof chrome !== 'undefined' &&
    chrome.tabs?.sendMessage
  ) {
    const isSuppressed = await isDomainSuppressed(snapshot.payload.domain);
    const beforeWarning = await requestPageIdentity(tabId);
    if (
      !isSuppressed &&
      beforeWarning &&
      sameSnapshotPageIdentity(beforeWarning, updatedSnapshot) &&
      !beforeWarning.warningVisible &&
      tabAnalysisStore.isCurrentSnapshot(updatedSnapshot)
    ) {
      const cfg = await getWarningConfig();
      const warningIdentity = await requestPageIdentity(tabId);
      if (
        !warningIdentity ||
        !sameSnapshotPageIdentity(warningIdentity, updatedSnapshot) ||
        warningIdentity.warningVisible ||
        !tabAnalysisStore.isCurrentSnapshot(updatedSnapshot)
      ) {
        return verdict;
      }
      const effectiveType = decideSmartWarningType(cfg.warningType, {
        hasCredentialField: snapshot.payload.hasCredentialField,
        riskScore: verdict.confidence,
        reasons: verdict.explanationReasons,
      });
      if (effectiveType === 'notification') {
        await triggerDesktopNotification(
          snapshot.payload.domain,
          verdict.targetBrand,
          verdict.explanationReasons,
          cfg.snoozeDurationMinutes,
          {
            tabId,
            pageSessionId: updatedSnapshot.pageSessionId,
            navigationGeneration: updatedSnapshot.navigationGeneration,
            url: updatedSnapshot.url,
          }
        );
      }
      chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_PHISHING_BANNER',
        brand: verdict.targetBrand,
        reasons: verdict.explanationReasons,
        warningType: cfg.warningType,
        effectiveType,
        hasCredentialField: snapshot.payload.hasCredentialField,
        riskScore: verdict.confidence,
        snoozeDurationMinutes: cfg.snoozeDurationMinutes,
        pageSessionId: updatedSnapshot.pageSessionId,
        navigationGeneration: updatedSnapshot.navigationGeneration,
        evaluationGeneration: updatedSnapshot.evaluationGeneration,
        url: updatedSnapshot.url,
      });
    }
  }
  return verdict;
}

function matchesTabAnalysisReference(snapshot: TabAnalysisSnapshot, reference: unknown): boolean {
  if (!reference || typeof reference !== 'object') return false;
  const expected = reference as Partial<TabAnalysisReference>;
  return expected.pageSessionId === snapshot.pageSessionId &&
    expected.navigationGeneration === snapshot.navigationGeneration &&
    expected.evaluationGeneration === snapshot.evaluationGeneration &&
    expected.telemetryId === snapshot.telemetryId &&
    expected.url === snapshot.url &&
    expected.warningVisible === snapshot.warningVisible &&
    expected.topologyScanComplete === snapshot.topologyScanComplete;
}

export async function clearTabCloudVerdict(tabId: number, reference?: unknown): Promise<boolean> {
  const snapshot = await getTabAnalysisSnapshot(tabId);
  const identity = await requestPageIdentity(tabId);
  if (!snapshot || !identity || !sameSnapshotPageIdentity(identity, snapshot)) return false;
  if (reference !== undefined && !matchesTabAnalysisReference(snapshot, reference)) return false;
  if (!tabAnalysisStore.isCurrentSnapshot(snapshot) || !tabAnalysisStore.clearCloudVerdict(snapshot)) {
    return false;
  }
  const updated = tabAnalysisStore.get(tabId, snapshot.url);
  if (!updated) return false;
  await persistTabAnalysisSnapshot(updated);
  return tabAnalysisStore.isCurrentSnapshot(updated);
}

async function requestTabEvaluation(tabId: number): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
    throw new Error('The active page could not be refreshed for cloud verification.');
  }
  const response = await sendTabMessageWithCollectorRecovery(
    tabId,
    { type: 'REQUEST_TELEMETRY_EVALUATION', forceVision: true }
  );
  if (response === null) {
    throw new Error('The active page could not be refreshed for cloud verification.');
  }
}

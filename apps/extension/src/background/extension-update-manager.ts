/**
 * PhishGuard Extension Self-Update Manager
 *
 * Coordinates:
 * 1. Extension version comparison against backend artifact registry.
 * 2. Visual badge alerts, native desktop notifications, and popup banner prompts.
 * 3. Seamless one-click install/download and Chromium runtime reload handling.
 *
 * Update channels (picked at runtime via chrome.management.getSelf()):
 * - NATIVE: installed from a source with update_url (Web Store / self-hosted CRX). Chrome downloads
 *   updates itself; we defer application and offer a one-click "Restart to update".
 * - MANUAL_CRX: legacy CRX install without update_url; user installs the new CRX once.
 * - MANUAL_UNPACKED: "Load unpacked" install; user unzips over the folder and reloads.
 */

import type {
  ExtensionReleaseMeta,
  ExtensionUpdateChannel,
  ExtensionUpdateStatus,
  ExtensionUpdateCheckMethod,
  ExtensionVersionsList,
} from '@phishguard/types';

export function compareSemver(v1: string, v2: string): number {
  const clean = (v: string) => v.trim().replace(/^v/i, '').trim();
  const parts1 = clean(v1).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const parts2 = clean(v2).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] ?? 0;
    const num2 = parts2[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

import { DEFAULT_BACKEND_URL } from '../config.js';

export class ExtensionUpdateManager {
  private backendUrl: string = DEFAULT_BACKEND_URL;
  private currentVersion: string = '0.1.0';
  private lastStatus: ExtensionUpdateStatus | null = null;
  private isNativeUpdatePending: boolean = false;
  private channel: ExtensionUpdateChannel | null = null;

  constructor() {
    this.initVersion();
    this.setupListeners();
  }

  private initVersion(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      try {
        const manifest = chrome.runtime.getManifest();
        if (manifest.version) {
          this.currentVersion = manifest.version;
        }
      } catch {
        // Fallback default
      }
    }
  }

  private setupListeners(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onUpdateAvailable) {
      chrome.runtime.onUpdateAvailable.addListener((details) => {
        console.log(`[PhishGuard Update] Native update available and staged: v${details.version}`);
        this.markNativeUpdateReady(details.version);
      });
    }

    if (typeof chrome !== 'undefined' && chrome.notifications?.onClicked) {
      chrome.notifications.onClicked.addListener((notificationId) => {
        if (notificationId.startsWith('phishguard-update')) {
          this.installExtensionUpdate().catch((e) => console.warn('[PhishGuard Update] Install error:', e));
        }
      });
    }

    if (typeof chrome !== 'undefined' && chrome.notifications?.onButtonClicked) {
      chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
        if (notificationId.startsWith('phishguard-update')) {
          if (buttonIndex === 0) {
            this.installExtensionUpdate().catch((e) => console.warn('[PhishGuard Update] Install error:', e));
          } else if (buttonIndex === 1) {
            this.openDownloadPage();
          }
        }
      });
    }
  }

  public getBackendUrl(): string {
    return this.backendUrl;
  }

  public setBackendUrl(url: string): void {
    this.backendUrl = url.replace(/\/+$/, '');
  }

  public getCurrentVersion(): string {
    return this.currentVersion;
  }

  public getLastStatus(): ExtensionUpdateStatus | null {
    return this.lastStatus;
  }

  public isUpdatePendingReload(): boolean {
    return this.isNativeUpdatePending;
  }

  /**
   * Determines how this install receives updates. Cached after the first successful detection.
   */
  public async detectChannel(): Promise<ExtensionUpdateChannel> {
    if (this.channel) return this.channel;

    let detected: ExtensionUpdateChannel = 'MANUAL_CRX';
    if (typeof chrome !== 'undefined') {
      try {
        const self = chrome.management?.getSelf ? await chrome.management.getSelf() : null;
        const manifest = chrome.runtime?.getManifest?.() as { update_url?: string } | undefined;
        if (self?.installType === 'development') {
          detected = 'MANUAL_UNPACKED';
        } else if (manifest?.update_url) {
          detected = 'NATIVE';
        }
        if (self) this.channel = detected;
      } catch {
        // Unsupported context; fall back to manual CRX behavior
      }
    }
    return detected;
  }

  private markNativeUpdateReady(version: string): void {
    this.isNativeUpdatePending = true;
    if (this.lastStatus) {
      this.lastStatus = { ...this.lastStatus, nativeUpdateReady: true };
      this.persistStatus(this.lastStatus);
    }
    this.updateBadge('READY', '#10b981', `Update v${version} ready. Click to restart.`);
    this.notifyUser(
      `Update v${version} Ready`,
      'PhishGuard has downloaded a new version. Restart to update; your settings are kept.',
      undefined,
      [{ title: 'Restart to update' }]
    );
  }

  private async persistStatus(status: ExtensionUpdateStatus): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ extensionUpdateStatus: status });
    }
  }

  private async loadPreviousStatus(): Promise<ExtensionUpdateStatus | null> {
    if (this.lastStatus) return this.lastStatus;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const res = await chrome.storage.local.get('extensionUpdateStatus');
        return (res?.extensionUpdateStatus as ExtensionUpdateStatus | undefined) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Asks Chrome to check the update_url now. Returns the raw result status (e.g. throttled).
   */
  private async requestNativeUpdateCheck(): Promise<{ status: string; version?: string } | null> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.requestUpdateCheck) return null;
    try {
      const result = (await chrome.runtime.requestUpdateCheck()) as { status: string; version?: string };
      console.log(`[PhishGuard Update] Native update check result: ${result?.status}`, result);
      if (result?.status === 'update_available') {
        this.isNativeUpdatePending = true;
      }
      return result ?? null;
    } catch (e) {
      console.warn('[PhishGuard Update] Native update check failed:', e);
      return null;
    }
  }

  /**
   * Check for extension updates from the backend artifact storage / API.
   */
  public async checkForExtensionUpdate(options?: {
    interactive?: boolean;
    checkMethod?: ExtensionUpdateCheckMethod;
  }): Promise<ExtensionUpdateStatus> {
    const channel = await this.detectChannel();
    const isNative = channel === 'NATIVE';
    const method =
      options?.checkMethod || (isNative ? 'NATIVE_RUNTIME' : options?.interactive ? 'MANUAL_CHECK' : 'API_POLL');
    const now = new Date().toISOString();
    const previous = await this.loadPreviousStatus();

    const nativeResult = isNative ? await this.requestNativeUpdateCheck() : null;
    const throttled = nativeResult?.status === 'throttled';

    try {
      const endpoint = `${this.backendUrl}/v1/extension/latest`;
      const response = await fetch(endpoint, { method: 'GET' });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const meta = (await response.json()) as ExtensionReleaseMeta;
      const latestVer = meta.version || '0.1.0';
      const hasUpdate = compareSemver(latestVer, this.currentVersion) > 0;

      let statusMessage = hasUpdate
        ? `Update v${latestVer} available (installed: v${this.currentVersion})`
        : `Extension is up to date (v${this.currentVersion})`;
      if (isNative && this.isNativeUpdatePending) {
        statusMessage = `Update v${nativeResult?.version || latestVer} downloaded. Restart to update.`;
      } else if (isNative && hasUpdate) {
        statusMessage = `v${latestVer} published; Chrome will fetch it automatically.`;
      }
      if (throttled) {
        statusMessage += ' (Chrome throttled the update check; try again later.)';
      }

      const alreadyNotified = Boolean(
        previous?.installPromptShown && previous.latestVersion === latestVer && previous.updateAvailable
      );

      const status: ExtensionUpdateStatus = {
        currentVersion: this.currentVersion,
        latestVersion: latestVer,
        updateAvailable: hasUpdate,
        lastChecked: now,
        checkMethod: method,
        backendReachable: true,
        releaseMeta: meta,
        statusMessage,
        installPromptShown: hasUpdate && (alreadyNotified || options?.interactive || false),
        updateChannel: channel,
        nativeUpdateReady: this.isNativeUpdatePending,
      };

      // Handle UI alert states
      if (this.isNativeUpdatePending) {
        this.updateBadge('READY', '#10b981', `Update v${nativeResult?.version || latestVer} ready. Click to restart.`);
      } else if (hasUpdate) {
        this.updateBadge('UP', '#f59e0b', `PhishGuard update available: v${latestVer}`);
        if (!isNative && (options?.interactive || !alreadyNotified)) {
          this.notifyUser(
            'PhishGuard Update Available',
            `A new version (v${latestVer}) is available. Current: v${this.currentVersion}. Click to update!`,
            meta
          );
          status.installPromptShown = true;
        }
      } else {
        this.clearBadge();
      }

      this.lastStatus = status;
      await this.persistStatus(status);

      return status;
    } catch (err) {
      console.warn('[PhishGuard Update] Backend update check failed:', err);

      const fallback: ExtensionUpdateStatus = {
        currentVersion: this.currentVersion,
        latestVersion: this.lastStatus?.latestVersion || this.currentVersion,
        updateAvailable: this.lastStatus?.updateAvailable || false,
        lastChecked: now,
        checkMethod: 'OFFLINE_CACHE',
        backendReachable: false,
        releaseMeta: this.lastStatus?.releaseMeta,
        statusMessage: `Backend unreachable (${err instanceof Error ? err.message : String(err)})`,
        installPromptShown: false,
        updateChannel: channel,
        nativeUpdateReady: this.isNativeUpdatePending,
      };

      return fallback;
    }
  }

  /**
   * Dispatches install or reload action for the extension update.
   */
  public async installExtensionUpdate(): Promise<{
    success: boolean;
    action: 'RELOAD_TRIGGERED' | 'UPDATE_CHECK_REQUESTED' | 'DOWNLOAD_OPENED';
    url?: string;
    message?: string;
  }> {
    const channel = await this.detectChannel();

    if (channel === 'NATIVE') {
      // Never open a CRX download here: a Web Store install would get a second copy with a different ID
      if (this.isNativeUpdatePending && typeof chrome !== 'undefined' && chrome.runtime?.reload) {
        console.log('[PhishGuard Update] Applying native update reload...');
        chrome.runtime.reload();
        return { success: true, action: 'RELOAD_TRIGGERED' };
      }

      const result = await this.requestNativeUpdateCheck();
      let message = 'Update check requested. Chrome will download any new version in the background.';
      if (result?.status === 'throttled') {
        message = 'Chrome throttled the update check; try again later.';
      } else if (result?.status === 'update_available') {
        message = 'An update is downloading. Restart to update once it is ready.';
      } else if (result?.status === 'no_update') {
        message = 'No update available from Chrome.';
      }
      return { success: true, action: 'UPDATE_CHECK_REQUESTED', message };
    }

    const meta = this.lastStatus?.releaseMeta;
    let targetUrl: string;
    let message: string;

    if (channel === 'MANUAL_UNPACKED') {
      const zipUrl = meta?.download_url || '/download/extension';
      targetUrl = zipUrl.startsWith('http') ? zipUrl : `${this.backendUrl}${zipUrl}`;
      message = 'Unzip over your existing folder, then click Reload.';
    } else {
      targetUrl = `${this.backendUrl}/download/crx`;
      if (meta?.crx_download_url) {
        targetUrl = meta.crx_download_url.startsWith('http')
          ? meta.crx_download_url
          : `${this.backendUrl}${meta.crx_download_url}`;
      } else if (meta?.download_url) {
        targetUrl = meta.download_url.startsWith('http')
          ? meta.download_url
          : `${this.backendUrl}${meta.download_url}`;
      }
      message = 'Install once over your current version. Your settings are kept and later updates are automatic.';
    }

    console.log(`[PhishGuard Update] Directing user to download update package: ${targetUrl}`);
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      await chrome.tabs.create({ url: targetUrl });
    } else if (typeof window !== 'undefined') {
      window.open(targetUrl, '_blank');
    }

    return {
      success: true,
      action: 'DOWNLOAD_OPENED',
      url: targetUrl,
      message,
    };
  }

  public async getAvailableVersions(): Promise<ExtensionVersionsList> {
    const endpoint = `${this.backendUrl}/v1/extension/versions`;
    const response = await fetch(endpoint, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as ExtensionVersionsList;
  }

  public async installVersion(version: string, format: 'crx' | 'zip' = 'crx'): Promise<{
    success: boolean;
    url: string;
  }> {
    const cleanVer = version.replace(/^v/i, '').trim();
    const targetUrl = `${this.backendUrl}/download/version/${cleanVer}/${format}`;
    console.log(`[PhishGuard Update] Opening versioned package download: ${targetUrl}`);
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      await chrome.tabs.create({ url: targetUrl });
    } else if (typeof window !== 'undefined') {
      window.open(targetUrl, '_blank');
    }
    return {
      success: true,
      url: targetUrl,
    };
  }

  public async openDownloadPage(): Promise<void> {
    const url = `${this.backendUrl}/download`;
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      await chrome.tabs.create({ url });
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }

  private updateBadge(text: string, color: string, title?: string): void {
    if (typeof chrome !== 'undefined' && chrome.action?.setBadgeText) {
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color });
      if (title && chrome.action.setTitle) {
        chrome.action.setTitle({ title });
      }
    }
  }

  private clearBadge(): void {
    if (typeof chrome !== 'undefined' && chrome.action?.setBadgeText) {
      chrome.action.setBadgeText({ text: '' });
      if (chrome.action.setTitle) {
        chrome.action.setTitle({ title: 'PhishGuard Threat Inspector' });
      }
    }
  }

  private notifyUser(
    title: string,
    message: string,
    _meta?: ExtensionReleaseMeta,
    buttons: { title: string }[] = [{ title: 'Install Update' }, { title: 'Download Page' }]
  ): void {
    if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
      try {
        chrome.notifications.create(
          `phishguard-update-${Date.now()}`,
          {
            type: 'basic',
            iconUrl: chrome.runtime.getURL ? chrome.runtime.getURL('icons/icon128.png') : 'icons/icon128.png',
            title,
            message,
            buttons,
            priority: 2,
            requireInteraction: true,
          },
          (notificationId) => {
            console.log(`[PhishGuard Update] Desktop notification emitted: ${notificationId}`);
          }
        );
      } catch (e) {
        console.warn('[PhishGuard Update] Notification dispatch failed:', e);
      }
    }
  }
}

export const extensionUpdateManager = new ExtensionUpdateManager();

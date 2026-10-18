/**
 * PhishGuard Settings Page Controller
 * Allows developers and security analysts to configure the FastAPI backend URL.
 */

import { DEFAULT_BACKEND_URL } from '../src/config.js';

export { DEFAULT_BACKEND_URL };

export function normalizeEndpointUrl(url: string): string {
  let trimmed = url.trim();
  if (!trimmed) {
    return DEFAULT_BACKEND_URL;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed.replace(/\/+$/, '');
}

export async function pingBackend(baseUrl: string): Promise<{
  ok: boolean;
  status: string;
  service?: string;
  version?: string;
  latestModel?: string;
  latencyMs: number;
  error?: string;
}> {
  const start = performance.now();
  try {
    const healthUrl = `${baseUrl}/health`;
    const res = await fetch(healthUrl, { method: 'GET' });
    const latency = Math.round(performance.now() - start);

    if (!res.ok) {
      return {
        ok: false,
        status: `HTTP ${res.status} ${res.statusText}`,
        latencyMs: latency,
        error: `Server responded with error status ${res.status}`,
      };
    }

    const healthData = await res.json();

    // Also attempt to fetch latest model version
    let latestModelVer = 'N/A';
    try {
      const modelRes = await fetch(`${baseUrl}/v1/models/latest`);
      if (modelRes.ok) {
        const modelData = await modelRes.json();
        latestModelVer = `v${modelData.version} (${modelData.name})`;
      }
    } catch {
      // Model endpoint optional
    }

    return {
      ok: true,
      status: 'Connected (Healthy)',
      service: healthData.service || 'phishguard-backend',
      version: healthData.version || '0.1.0',
      latestModel: latestModelVer,
      latencyMs: latency,
    };
  } catch (err) {
    const latency = Math.round(performance.now() - start);
    return {
      ok: false,
      status: 'Connection Failed',
      latencyMs: latency,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
  const inputUrl = document.getElementById('backend-url') as HTMLInputElement;
  const btnApplyUrl = document.getElementById('btn-apply-url') as HTMLButtonElement | null;
  const btnTest = document.getElementById('btn-test') as HTMLButtonElement;
  const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
  const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  const btnClearCache = document.getElementById('btn-clear-cache') as HTMLButtonElement;
  const saveStatus = document.getElementById('save-status') as HTMLSpanElement;

  const diagBox = document.getElementById('diag-box') as HTMLDivElement;
  const diagStatus = document.getElementById('diag-status') as HTMLSpanElement;
  const diagService = document.getElementById('diag-service') as HTMLSpanElement;
  const diagTeacher = document.getElementById('diag-teacher') as HTMLSpanElement;
  const diagModel = document.getElementById('diag-model') as HTMLSpanElement;

  // Extension Update & Downgrade Elements
  const extCurrentVer = document.getElementById('ext-current-ver') as HTMLSpanElement | null;
  const extLatestVer = document.getElementById('ext-latest-ver') as HTMLSpanElement | null;
  const extUpdateStatus = document.getElementById('ext-update-status') as HTMLSpanElement | null;
  const extReleaseDetails = document.getElementById('ext-release-details') as HTMLDivElement | null;
  const extCrxSha256 = document.getElementById('ext-crx-sha256') as HTMLSpanElement | null;
  const extPkgSize = document.getElementById('ext-pkg-size') as HTMLSpanElement | null;
  const btnCheckExtUpdate = document.getElementById('btn-check-extension-update') as HTMLButtonElement | null;
  const btnCancelExtCheck = document.getElementById('btn-cancel-ext-check') as HTMLButtonElement | null;
  const btnInstallExtUpdate = document.getElementById('btn-install-extension-update') as HTMLButtonElement | null;
  const extUpdateHint = document.getElementById('ext-update-hint') as HTMLParagraphElement | null;
  let extCheckLabel = 'Check for Updates';
  const btnReloadExt = document.getElementById('btn-reload-extension') as HTMLButtonElement | null;
  const selectDowngrade = document.getElementById('select-downgrade-version') as HTMLSelectElement | null;
  const btnDowngrade = document.getElementById('btn-downgrade-version') as HTMLButtonElement | null;
  const downgradeStatus = document.getElementById('downgrade-status') as HTMLDivElement | null;

  let extCheckCancelled = false;
  let activeVersion = '0.1.0';
  if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
    try {
      activeVersion = chrome.runtime.getManifest().version || '0.1.0';
    } catch {
      // Fallback
    }
  }

  // Warning Configuration Elements
  const selectWarningType = document.getElementById('select-warning-type') as HTMLSelectElement | null;
  const selectSnoozeDuration = document.getElementById('select-snooze-duration') as HTMLSelectElement | null;
  const diagWarningMode = document.getElementById('diag-warning-mode') as HTMLSpanElement | null;
  const diagAckCount = document.getElementById('diag-ack-count') as HTMLSpanElement | null;
  const diagSnoozeCount = document.getElementById('diag-snooze-count') as HTMLSpanElement | null;
  const btnClearSuppressions = document.getElementById('btn-clear-suppressions') as HTMLButtonElement | null;

  function formatWarningModeLabel(mode: string): string {
    switch (mode) {
      case 'overlay': return 'Full-Screen Overlay';
      case 'banner': return 'Top Warning Banner';
      case 'notification': return 'Notification Toast & Desktop Alert';
      case 'smart':
      default:
        return 'Smart Adaptive (Recommended)';
    }
  }

  function renderWarningConfig(cfg: {
    warningType?: string;
    snoozeDurationMinutes?: number;
    acknowledgedDomains?: Record<string, number>;
    snoozedDomains?: Record<string, number>;
  }) {
    const type = cfg.warningType || 'smart';
    const duration = cfg.snoozeDurationMinutes !== undefined ? String(cfg.snoozeDurationMinutes) : '15';
    if (selectWarningType) selectWarningType.value = type;
    if (selectSnoozeDuration) selectSnoozeDuration.value = duration;
    if (diagWarningMode) diagWarningMode.textContent = formatWarningModeLabel(type);

    const now = Date.now();
    const activeAcks = Object.keys(cfg.acknowledgedDomains || {}).length;
    const activeSnoozes = Object.values(cfg.snoozedDomains || {}).filter((ts) => ts > now).length;

    if (diagAckCount) diagAckCount.textContent = `${activeAcks} site(s)`;
    if (diagSnoozeCount) diagSnoozeCount.textContent = `${activeSnoozes} site(s)`;
  }

  // 1. Load saved configuration
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get([
      'backendUrl',
      'warningType',
      'snoozeDurationMinutes',
      'acknowledgedDomains',
      'snoozedDomains',
    ], (result) => {
      inputUrl.value = result.backendUrl || DEFAULT_BACKEND_URL;
      renderWarningConfig(result);
      refreshAvailableVersions(inputUrl.value);
    });
  } else {
    inputUrl.value = DEFAULT_BACKEND_URL;
    renderWarningConfig({});
    refreshAvailableVersions(DEFAULT_BACKEND_URL);
  }

  // 2. Connectivity Testing Helper
  async function runConnectionTest(targetUrl: string) {
    btnTest.textContent = 'Testing...';
    btnTest.disabled = true;
    diagBox.style.display = 'block';
    diagStatus.textContent = 'Probing endpoint...';
    diagStatus.className = 'diag-val';

    const result = await pingBackend(targetUrl);

    btnTest.textContent = 'Test Connection';
    btnTest.disabled = false;

    if (result.ok) {
      diagStatus.textContent = '🟢 Connected (200 OK)';
      diagStatus.className = 'diag-val status-healthy';
      diagService.textContent = `${result.service} (v${result.version})`;
      diagTeacher.textContent = 'Multimodal PyTorch + BiLSTM';
      diagModel.textContent = result.latestModel || 'Available';
    } else {
      diagStatus.textContent = `🔴 Offline (${result.status})`;
      diagStatus.className = 'diag-val status-error';
      diagService.textContent = result.error || 'Server unreachable';
      diagTeacher.textContent = 'Unavailable';
      diagModel.textContent = 'Unavailable';
    }
    return result;
  }

  btnTest.addEventListener('click', () => {
    const cleanUrl = normalizeEndpointUrl(inputUrl.value);
    inputUrl.value = cleanUrl;
    runConnectionTest(cleanUrl);
  });

  // 3. Apply Backend URL throughout the app
  async function applyBackendUrl() {
    const cleanUrl = normalizeEndpointUrl(inputUrl.value);
    inputUrl.value = cleanUrl;

    if (btnApplyUrl) {
      btnApplyUrl.textContent = 'Applying...';
      btnApplyUrl.disabled = true;
    }

    const selectedWarning = selectWarningType?.value || 'smart';
    const selectedSnooze = Number(selectSnoozeDuration?.value || 15);

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({
        backendUrl: cleanUrl,
        warningType: selectedWarning,
        snoozeDurationMinutes: selectedSnooze,
      });

      // Notify background service worker to re-point all managers immediately
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'UPDATE_CONFIG',
          config: { backendUrl: cleanUrl },
        });
        chrome.runtime.sendMessage({
          type: 'UPDATE_WARNING_CONFIG',
          config: {
            warningType: selectedWarning,
            snoozeDurationMinutes: selectedSnooze,
          },
        });
      }
    }

    if (diagWarningMode) {
      diagWarningMode.textContent = formatWarningModeLabel(selectedWarning);
    }

    // Refresh connectivity & diagnostics
    await runConnectionTest(cleanUrl);

    // Refresh version list and update status
    refreshAvailableVersions(cleanUrl);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CHECK_EXTENSION_UPDATE', interactive: false }, (res) => {
        if (res && res.success && res.status) {
          renderExtensionUpdateStatus(res.status);
        }
      });
    }

    if (btnApplyUrl) {
      btnApplyUrl.textContent = 'Apply';
      btnApplyUrl.disabled = false;
    }

    saveStatus.textContent = '✓ Settings applied & refreshed across app';
    saveStatus.style.color = 'var(--safe)';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3500);
  }

  if (btnApplyUrl) {
    btnApplyUrl.addEventListener('click', applyBackendUrl);
  }

  // 4. Save Settings
  btnSave.addEventListener('click', applyBackendUrl);

  // 5. Reset Default
  btnReset.addEventListener('click', async () => {
    inputUrl.value = DEFAULT_BACKEND_URL;
    if (selectWarningType) selectWarningType.value = 'smart';
    if (selectSnoozeDuration) selectSnoozeDuration.value = '15';
    if (diagWarningMode) diagWarningMode.textContent = formatWarningModeLabel('smart');

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({
        backendUrl: DEFAULT_BACKEND_URL,
        warningType: 'smart',
        snoozeDurationMinutes: 15,
      });
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'UPDATE_CONFIG',
          config: { backendUrl: DEFAULT_BACKEND_URL },
        });
        chrome.runtime.sendMessage({
          type: 'UPDATE_WARNING_CONFIG',
          config: { warningType: 'smart', snoozeDurationMinutes: 15 },
        });
      }
      saveStatus.textContent = `✓ Reset to default settings`;
      saveStatus.style.color = 'var(--text-2)';
      setTimeout(() => {
        saveStatus.textContent = '';
      }, 3000);
    }
    refreshAvailableVersions(DEFAULT_BACKEND_URL);
  });

  // 6. Clear All Suppressions
  if (btnClearSuppressions) {
    btnClearSuppressions.addEventListener('click', async () => {
      btnClearSuppressions.textContent = 'Clearing...';
      btnClearSuppressions.disabled = true;

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({
          acknowledgedDomains: {},
          snoozedDomains: {},
        });
        if (chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CLEAR_ALL_SUPPRESSIONS' });
        }
      }

      setTimeout(() => {
        if (diagAckCount) diagAckCount.textContent = '0 site(s)';
        if (diagSnoozeCount) diagSnoozeCount.textContent = '0 site(s)';
        btnClearSuppressions.textContent = 'Clear All Snoozed & Acknowledged Sites';
        btnClearSuppressions.disabled = false;
        saveStatus.textContent = '✓ Cleared all snoozed and acknowledged sites';
        saveStatus.style.color = 'var(--safe)';
        setTimeout(() => {
          saveStatus.textContent = '';
        }, 3000);
      }, 300);
    });
  }

  // 6. Reset Local SQLite Cache
  btnClearCache.addEventListener('click', async () => {
    btnClearCache.textContent = 'Resetting...';
    btnClearCache.disabled = true;

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CHECK_MODEL_UPDATE' }, () => {
        setTimeout(() => {
          btnClearCache.textContent = 'Reset Local SQLite Cache';
          btnClearCache.disabled = false;
          saveStatus.textContent = '✓ Local cache reset & re-synced';
          saveStatus.style.color = 'var(--safe)';
          setTimeout(() => {
            saveStatus.textContent = '';
          }, 3000);
        }, 500);
      });
    } else {
      btnClearCache.textContent = 'Reset Local SQLite Cache';
      btnClearCache.disabled = false;
    }
  });

  // 7. Extension Self-Update Status and Actions
  let installButtonLabel = 'Download & Install Update';

  function applyChannelUi(status: any) {
    let checkLabel = 'Check for Updates';
    let hint = '';
    switch (status.updateChannel) {
      case 'NATIVE':
        installButtonLabel = 'Restart to update';
        checkLabel = 'Check now';
        hint = 'Chrome downloads updates automatically. Restart once an update is ready; your settings are kept.';
        break;
      case 'MANUAL_UNPACKED':
        installButtonLabel = 'Download zip';
        hint = 'Unzip over your existing folder, then click Reload Extension.';
        break;
      case 'MANUAL_CRX':
        installButtonLabel = 'Download & install (one-time)';
        hint = 'Install once over your current version. Your settings are kept and later updates are automatic.';
        break;
      default:
        installButtonLabel = 'Download & Install Update';
    }
    extCheckLabel = checkLabel;
    if (btnCheckExtUpdate && !btnCheckExtUpdate.disabled) btnCheckExtUpdate.textContent = checkLabel;
    if (btnInstallExtUpdate) btnInstallExtUpdate.textContent = installButtonLabel;
    if (extUpdateHint) {
      extUpdateHint.textContent = hint;
      extUpdateHint.style.display = hint ? 'block' : 'none';
    }
  }

  function renderExtensionUpdateStatus(status?: any) {
    if (!status) return;
    applyChannelUi(status);
    if (extCurrentVer) extCurrentVer.textContent = `v${status.currentVersion}`;
    if (extLatestVer) extLatestVer.textContent = `v${status.latestVersion}`;
    if (extUpdateStatus) {
      if (status.updateChannel === 'NATIVE' && status.nativeUpdateReady) {
        extUpdateStatus.textContent = `🟡 Update ready (v${status.latestVersion}) - restart to apply`;
        extUpdateStatus.style.color = 'var(--warn)';
        if (btnInstallExtUpdate) btnInstallExtUpdate.style.display = 'inline-flex';
      } else if (status.updateChannel === 'NATIVE' && status.updateAvailable) {
        extUpdateStatus.textContent = `🟡 v${status.latestVersion} published - Chrome will fetch it automatically`;
        extUpdateStatus.style.color = 'var(--warn)';
        if (btnInstallExtUpdate) btnInstallExtUpdate.style.display = 'none';
      } else if (status.updateAvailable) {
        extUpdateStatus.textContent = `🟡 Update Available (v${status.latestVersion})`;
        extUpdateStatus.style.color = 'var(--warn)';
        if (btnInstallExtUpdate) btnInstallExtUpdate.style.display = 'inline-flex';
      } else if (status.backendReachable) {
        extUpdateStatus.textContent = `🟢 Up to date (v${status.currentVersion})`;
        extUpdateStatus.style.color = 'var(--safe)';
        if (btnInstallExtUpdate) btnInstallExtUpdate.style.display = 'none';
      } else {
        extUpdateStatus.textContent = `⚪ Offline (${status.statusMessage || 'Backend unreachable'})`;
        extUpdateStatus.style.color = 'var(--text-2)';
      }
    }
    if (status.releaseMeta && extReleaseDetails) {
      extReleaseDetails.style.display = 'block';
      if (extCrxSha256) extCrxSha256.textContent = status.releaseMeta.crx_sha256 || status.releaseMeta.sha256 || 'N/A';
      if (extPkgSize) extPkgSize.textContent = status.releaseMeta.crx_size_formatted || status.releaseMeta.size_formatted || 'N/A';
    }
  }

  // Load initial update status
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['extensionUpdateStatus'], (res) => {
      if (res.extensionUpdateStatus) renderExtensionUpdateStatus(res.extensionUpdateStatus);
    });
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'GET_EXTENSION_UPDATE_STATUS' }, (res) => {
      if (res && res.success && res.status) renderExtensionUpdateStatus(res.status);
    });
  }

  // Check for Updates with Cancel Button
  if (btnCheckExtUpdate) {
    btnCheckExtUpdate.addEventListener('click', () => {
      extCheckCancelled = false;
      btnCheckExtUpdate.textContent = 'Checking...';
      btnCheckExtUpdate.disabled = true;
      if (btnCancelExtCheck) btnCancelExtCheck.style.display = 'inline-flex';
      if (extUpdateStatus) {
        extUpdateStatus.textContent = 'Checking backend releases...';
        extUpdateStatus.style.color = 'var(--text-2)';
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CHECK_EXTENSION_UPDATE', interactive: true }, (res) => {
          setTimeout(() => {
            if (btnCancelExtCheck) btnCancelExtCheck.style.display = 'none';
            if (extCheckCancelled) return;
            btnCheckExtUpdate.textContent = extCheckLabel;
            btnCheckExtUpdate.disabled = false;
            if (res && res.success && res.status) {
              renderExtensionUpdateStatus(res.status);
            }
            refreshAvailableVersions(inputUrl.value);
          }, 600);
        });
      } else {
        if (btnCancelExtCheck) btnCancelExtCheck.style.display = 'none';
        btnCheckExtUpdate.textContent = extCheckLabel;
        btnCheckExtUpdate.disabled = false;
      }
    });
  }

  if (btnCancelExtCheck) {
    btnCancelExtCheck.addEventListener('click', () => {
      extCheckCancelled = true;
      btnCancelExtCheck.style.display = 'none';
      if (btnCheckExtUpdate) {
        btnCheckExtUpdate.textContent = extCheckLabel;
        btnCheckExtUpdate.disabled = false;
      }
      if (extUpdateStatus) {
        extUpdateStatus.textContent = 'Update check canceled';
        extUpdateStatus.style.color = 'var(--text-2)';
      }
    });
  }

  if (btnInstallExtUpdate) {
    btnInstallExtUpdate.addEventListener('click', () => {
      btnInstallExtUpdate.textContent = installButtonLabel === 'Restart to update' ? 'Restarting...' : 'Working...';
      btnInstallExtUpdate.disabled = true;

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'INSTALL_EXTENSION_UPDATE' }, (res) => {
          if (res && res.message && extUpdateStatus) {
            extUpdateStatus.textContent = res.message;
            extUpdateStatus.style.color = 'var(--text-2)';
          }
          setTimeout(() => {
            btnInstallExtUpdate.textContent = installButtonLabel;
            btnInstallExtUpdate.disabled = false;
          }, 1200);
        });
      }
    });
  }

  if (btnReloadExt) {
    btnReloadExt.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.reload) {
        chrome.runtime.reload();
      } else {
        window.location.reload();
      }
    });
  }

  // 8. Available Versions & Downgrade Dropdown Logic
  async function refreshAvailableVersions(targetBaseUrl?: string) {
    if (!selectDowngrade) return;
    selectDowngrade.innerHTML = '<option value="">Querying available versions...</option>';
    if (btnDowngrade) btnDowngrade.disabled = true;

    const base = targetBaseUrl ? normalizeEndpointUrl(targetBaseUrl) : normalizeEndpointUrl(inputUrl.value);

    // Try service worker message first
    const populate = (versions: Array<{ version: string; is_latest?: boolean }>) => {
      selectDowngrade.innerHTML = '';
      if (!versions || versions.length === 0) {
        selectDowngrade.innerHTML = '<option value="">No versions available</option>';
        if (btnDowngrade) btnDowngrade.disabled = true;
        if (downgradeStatus) downgradeStatus.textContent = 'No packaged releases found in backend.';
        return;
      }

      for (const item of versions) {
        const opt = document.createElement('option');
        opt.value = item.version;
        const isCurrent = item.version === activeVersion;
        const isLatest = Boolean(item.is_latest);
        opt.textContent = `v${item.version}${isLatest ? ' ★ (latest)' : ''}${isCurrent ? ' (installed)' : ''}`;
        if (isCurrent) {
          opt.selected = true;
        }
        selectDowngrade.appendChild(opt);
      }

      if (btnDowngrade) btnDowngrade.disabled = false;
      if (downgradeStatus) {
        downgradeStatus.textContent = `${versions.length} release version(s) available on ${base}.`;
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_EXTENSION_VERSIONS' }, async (res) => {
        if (res && res.success && res.list?.versions) {
          populate(res.list.versions);
        } else {
          // Direct fetch fallback
          try {
            const resp = await fetch(`${base}/v1/extension/versions`);
            if (resp.ok) {
              const data = await resp.json();
              populate(data.versions || []);
            } else {
              selectDowngrade.innerHTML = '<option value="">Unable to query versions</option>';
              if (downgradeStatus) downgradeStatus.textContent = `Endpoint returned HTTP ${resp.status}`;
            }
          } catch {
            selectDowngrade.innerHTML = '<option value="">Backend offline</option>';
            if (downgradeStatus) downgradeStatus.textContent = 'Could not contact backend versions registry.';
          }
        }
      });
    } else {
      try {
        const resp = await fetch(`${base}/v1/extension/versions`);
        if (resp.ok) {
          const data = await resp.json();
          populate(data.versions || []);
        }
      } catch {
        selectDowngrade.innerHTML = '<option value="">Offline</option>';
      }
    }
  }

  if (btnDowngrade && selectDowngrade) {
    btnDowngrade.addEventListener('click', () => {
      const selectedVer = selectDowngrade.value;
      if (!selectedVer) return;

      btnDowngrade.textContent = 'Downloading...';
      btnDowngrade.disabled = true;
      if (downgradeStatus) {
        downgradeStatus.textContent = `Opening download package for v${selectedVer}...`;
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'INSTALL_EXTENSION_VERSION', version: selectedVer },
          () => {
            setTimeout(() => {
              btnDowngrade.textContent = 'Install / Downgrade';
              btnDowngrade.disabled = false;
              if (downgradeStatus) {
                downgradeStatus.textContent = `Package for v${selectedVer} opened. Follow browser prompt or Load Unpacked.`;
              }
            }, 1000);
          }
        );
      } else {
        const base = normalizeEndpointUrl(inputUrl.value);
        window.open(`${base}/download/version/${selectedVer}/zip`, '_blank');
        btnDowngrade.textContent = 'Install / Downgrade';
        btnDowngrade.disabled = false;
      }
    });
  }
});
}

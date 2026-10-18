/**
 * PhishGuard Extension Popup Dashboard Controller
 * Displays on-device telemetry analysis, threat routing, and model versioning/sync status.
 */

import type {
  ModelSyncStatus,
  ExtensionUpdateStatus,
  CloudInferenceVerdict,
  WarningPresentationType,
} from '@phishguard/types';
import type { GetTabAnalysisRequest } from '../src/background/tab-analysis-state.js';
import type { LocalRuntimeState, ModalityBreakdown, VisionCaptureState } from '../src/background/types.js';
import {
  presentAssessment,
  decideFetchAnalysisPresentation,
  holdSafeDuringRescan,
  type AssessmentInput,
  type AssessmentPresentation,
  type CoverageHoldState,
} from './analysis-presentation.js';
import { presentModelRuntime } from './model-presentation.js';

interface LatestAnalysis {
  url: string;
  domain: string;
  telemetryId?: string;
  pageSessionId?: string;
  navigationGeneration?: number;
  evaluationGeneration?: number;
  riskScore: number;
  action: 'SAFE' | 'AMBIGUOUS' | 'BLOCK';
  evaluatedAt: string;
  modelVersion?: string;
  pointerSamples: number;
  keystrokeSamples: number;
  domAnomalies: number;
  signals?: ModalityBreakdown;
}

interface TabAnalysisSnapshotView {
  tabId: number;
  pageSessionId: string;
  navigationGeneration: number;
  evaluationGeneration: number;
  url: string;
  warningVisible: boolean;
  topologyScanComplete: boolean;
  telemetryId: string;
  analysis: LatestAnalysis;
  cloudVerdict: CloudInferenceVerdict | null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const domainText = document.getElementById('domain-text')!;
  const riskScore = document.getElementById('risk-score')!;
  const meterFill = document.getElementById('meter-fill')!;
  const statusBadge = document.getElementById('status-badge')!;
  const chkIncludeScreenshot = document.getElementById('chk-include-screenshot') as HTMLInputElement | null;
  const btnInspect = document.getElementById('btn-inspect')!;
  const btnSync = document.getElementById('btn-sync')!;
  const btnCancelSync = document.getElementById('btn-cancel-sync') as HTMLButtonElement | null;
  let isSyncCancelled = false;
  let isUpdateAvailablePending = false;

  // Extension Update Banner Elements
  const updateBanner = document.getElementById('update-banner');
  const updateTargetVer = document.getElementById('update-target-ver');
  const updateCurrentVer = document.getElementById('update-current-ver');
  const btnUpdateNow = document.getElementById('btn-update-now') as HTMLButtonElement | null;
  const btnDismissUpdate = document.getElementById('btn-dismiss-update');
  const extVersionText = document.getElementById('ext-version-text');

  // Model Update Banner & Prompt Elements
  const modelUpdateBanner = document.getElementById('model-update-banner');
  const modelTargetVer = document.getElementById('model-target-ver');
  const modelCurrentVer = document.getElementById('model-current-ver');
  const btnHotswapNow = document.getElementById('btn-hotswap-now') as HTMLButtonElement | null;
  const btnDismissModelUpdate = document.getElementById('btn-dismiss-model-update');
  const modelStatusNote = document.getElementById('model-status-note');

  // Suppression Banner Elements
  const suppressionBanner = document.getElementById('suppression-banner');
  const suppressionStatusTitle = document.getElementById('suppression-status-title');
  const suppressionStatusDesc = document.getElementById('suppression-status-desc');
  const btnRearmDomain = document.getElementById('btn-rearm-domain') as HTMLButtonElement | null;
  const selectPopupWarningType = document.getElementById('select-popup-warning-type') as HTMLSelectElement | null;
  const warningModeText = document.getElementById('warning-mode-text');
  let currentActiveHostname = '';
  let activeTabId: number | undefined;

  // Model Section Elements
  const modelSyncBadge = document.getElementById('model-sync-badge')!;
  const modelVersionText = document.getElementById('model-version-text')!;
  let modelRuntimeState: LocalRuntimeState = 'loading';
  let modelStatusPollStartedAt: number | null = null;
  let modelStatusPollTimer: number | null = null;
  let modelStatusRequestInFlight = false;

  // Cloud Verification Section Elements
  const cloudSection = document.getElementById('cloud-section');
  const cloudIndicator = document.getElementById('cloud-indicator')!;
  const cloudPromptView = document.getElementById('cloud-prompt-view')!;
  const cloudResultView = document.getElementById('cloud-result-view')!;
  const cloudDesc = document.getElementById('cloud-desc')!;
  const btnEscalate = document.getElementById('btn-escalate') as HTMLButtonElement | null;
  const btnReEscalate = document.getElementById('btn-re-escalate') as HTMLButtonElement | null;
  const cloudVerdictBox = document.getElementById('cloud-verdict-box')!;
  const cloudVerdictTitle = document.getElementById('cloud-verdict-title')!;
  const cloudBrandRow = document.getElementById('cloud-brand-row')!;
  const cloudBrandName = document.getElementById('cloud-brand-name')!;
  const cloudTeacherVersion = document.getElementById('cloud-teacher-version')!;
  const cloudReasonsList = document.getElementById('cloud-reasons-list')!;

  // Multimodal Explainability Elements
  const btnToggleExplain = document.getElementById('btn-toggle-explain');
  const signalsExplainDrawer = document.getElementById('signals-explain-drawer');
  const explainToggleText = document.getElementById('explain-toggle-text');

  if (btnToggleExplain && signalsExplainDrawer) {
    btnToggleExplain.addEventListener('click', () => {
      const isVisible = signalsExplainDrawer.style.display !== 'none';
      signalsExplainDrawer.style.display = isVisible ? 'none' : 'flex';
      btnToggleExplain.classList.toggle('open', !isVisible);
      if (explainToggleText) {
        explainToggleText.textContent = isVisible ? 'Explain Details' : 'Hide Details';
      }
    });
  }

  // 1. Fetch current tab info & trigger active evaluation
  let activeTabUrl = '';
  let currentTabSnapshot: TabAnalysisSnapshotView | null = null;
  // Display-only last completed same-page analysis rendered while a newer
  // evaluation is pending; never assigned to currentTabSnapshot.
  let displaySnapshot: TabAnalysisSnapshotView | null = null;
  let analysisRequestGeneration = 0;
  let analysisUpdating = false;
  let userInitiatedCheck = false;
  let coverageHold: CoverageHoldState | null = null;
  let analysisWatchdogTimer: number | null = null;
  let analysisPollTimer: number | null = null;
  let analysisPhaseText = 'Checking the current page on-device.';
  updateTelemetryUI(undefined, true);

  const ANALYSIS_WATCHDOG_MS = 10_000;
  const ANALYSIS_POLL_MS = 1_000;

  function phaseProgressText(phase: string): string {
    switch (phase) {
      case 'collecting': return 'Collecting page telemetry…';
      case 'capturing': return 'Capturing the visual frame…';
      case 'analyzing': return 'Running the on-device analysis…';
      default: return 'Checking the current page on-device.';
    }
  }

  function clearAnalysisWatchdog() {
    if (analysisWatchdogTimer !== null) {
      window.clearTimeout(analysisWatchdogTimer);
      analysisWatchdogTimer = null;
    }
  }

  function clearAnalysisPoll() {
    if (analysisPollTimer !== null) {
      window.clearTimeout(analysisPollTimer);
      analysisPollTimer = null;
    }
  }

  /**
   * Bounded re-read of the strict+display store while an evaluation is
   * in-flight. Stops when a fetch reports a current result, when the 10 s
   * watchdog fires, or when the popup unloads.
   */
  function scheduleAnalysisPoll() {
    if (analysisPollTimer !== null || !analysisUpdating || activeTabId === undefined) return;
    analysisPollTimer = window.setTimeout(() => {
      analysisPollTimer = null;
      if (!analysisUpdating || activeTabId === undefined) return;
      void fetchTabAnalysis(activeTabId, activeTabUrl).then((result) => {
        if (!result?.current) scheduleAnalysisPoll();
      });
    }, ANALYSIS_POLL_MS);
  }

  function beginAnalysisUpdating(phaseText?: string) {
    analysisUpdating = true;
    analysisPhaseText = phaseText ?? 'Checking the current page on-device.';
    updateTelemetryUI((displaySnapshot ?? currentTabSnapshot)?.analysis, true, true);
    scheduleAnalysisPoll();
    clearAnalysisWatchdog();
    analysisWatchdogTimer = window.setTimeout(() => {
      analysisWatchdogTimer = null;
      clearAnalysisPoll();
      if (!analysisUpdating) return;
      analysisPhaseText = 'Analysis is taking longer than expected…';
      // Keep Re-evaluate available as the retry affordance; the analysis
      // may still be running — this is not a cancellation.
      btnInspect.textContent = 'Re-evaluate Page';
      btnInspect.removeAttribute('disabled');
      updateTelemetryUI((displaySnapshot ?? currentTabSnapshot)?.analysis, true, true);
    }, ANALYSIS_WATCHDOG_MS);
  }

  function finishAnalysisUpdating() {
    analysisUpdating = false;
    userInitiatedCheck = false;
    clearAnalysisWatchdog();
    clearAnalysisPoll();
  }

  /**
   * The page cannot host a collector (restricted or internal scheme).
   * Explains the actual limitation instead of the generic NOT ASSESSED.
   */
  function showRestrictedPage() {
    finishAnalysisUpdating();
    updateTelemetryUI(undefined, false);
    statusBadge.textContent = 'RESTRICTED';
    if (cloudDesc) {
      cloudDesc.textContent = "PhishGuard can't analyze this page — the browser restricts access to it.";
    }
  }

  window.addEventListener('pagehide', () => {
    clearAnalysisWatchdog();
    clearAnalysisPoll();
    if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
      try {
        chrome.tabs.onUpdated.removeListener(handleActiveTabUrlChange);
      } catch {}
    }
  });

  /**
   * Ask the tab collector for a fresh evaluation via the background worker.
   * Collector injection lives exclusively behind REQUEST_TAB_EVALUATION in
   * the service worker so a single once-per-document guard owns it.
   */
  function requestTabEvaluation(
    tabId: number,
    onResult: (
      response: { evalResult?: { result?: LatestAnalysis } } | null,
      reason?: 'restricted' | 'no_collector'
    ) => void
  ): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      onResult(null, 'no_collector');
      return;
    }
    const requestMarker = ++analysisRequestGeneration;
    try {
      chrome.runtime.sendMessage(
        { type: 'REQUEST_TAB_EVALUATION', tabId, forceVision: true },
        (res) => {
          if (requestMarker !== analysisRequestGeneration) return;
          if (chrome.runtime.lastError || !res?.success) {
            onResult(null, res?.reason === 'restricted' ? 'restricted' : 'no_collector');
            return;
          }
          onResult(res.response as { evalResult?: { result?: LatestAnalysis } } | null);
        }
      );
    } catch {
      onResult(null, 'no_collector');
    }
  }

  function fetchTabAnalysis(
    tabId: number,
    url: string
  ): Promise<{ snapshot: TabAnalysisSnapshotView; current: boolean } | null> {
    return new Promise((resolve) => {
      const requestGeneration = ++analysisRequestGeneration;
      // Never clear the UI at request start: a pending evaluation keeps the
      // updating view and a miss only shows NOT ASSESSED when nothing is
      // known to be in-flight.
      const fail = () => {
        const decision = decideFetchAnalysisPresentation(false, undefined, analysisUpdating);
        if (decision === 'empty') {
          displaySnapshot = null;
          renderCloudVerdict(null);
          updateTelemetryUI(undefined, false);
        } else {
          updateTelemetryUI((displaySnapshot ?? currentTabSnapshot)?.analysis, true, true);
        }
        resolve(null);
      };
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        fail();
        return;
      }
      const request: GetTabAnalysisRequest = { type: 'GET_TAB_ANALYSIS', tabId, url };
      try {
        chrome.runtime.sendMessage(
          request,
          (response) => {
            if (requestGeneration !== analysisRequestGeneration) {
              resolve(null);
              return;
            }
            if (chrome.runtime.lastError) {
              fail();
              return;
            }
            const snapshot = response?.success ? response.snapshot as TabAnalysisSnapshotView | null : null;
            const valid = !!snapshot && snapshot.tabId === tabId && snapshot.url === url &&
              snapshot.analysis?.url === url;
            const decision = decideFetchAnalysisPresentation(
              valid,
              response?.current,
              analysisUpdating
            );
            if (!valid || !snapshot || decision === 'pending' || decision === 'empty') {
              fail();
              return;
            }
            if (decision === 'previous') {
              // Display-only last completed analysis: the last verdict stays
              // visible while refreshing and cloud actions stay disabled;
              // never becomes the current snapshot used by strict flows.
              displaySnapshot = snapshot;
              updateTelemetryUI(snapshot.analysis, true, true);
              renderCloudVerdict(snapshot.cloudVerdict);
              resolve({ snapshot, current: false });
              return;
            }
            displaySnapshot = null;
            finishAnalysisUpdating();
            currentTabSnapshot = snapshot;
            updateTelemetryUI(snapshot.analysis);
            renderCloudVerdict(snapshot.cloudVerdict);
            resolve({ snapshot, current: true });
          }
        );
      } catch {
        fail();
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        activeTabUrl = tab.url;
        activeTabId = tab.id;
        try {
          const urlObj = new URL(tab.url);
          domainText.textContent = tab.url;
          domainText.title = tab.url;
          currentActiveHostname = urlObj.hostname;
          checkDomainSuppressionState(currentActiveHostname);
        } catch {
          domainText.textContent = tab.url;
          domainText.title = tab.url;
          currentActiveHostname = tab.url;
        }
        if (tab.id !== undefined && /^https?:\/\//i.test(tab.url)) {
          // Instant display of the strict current analysis or the last
          // completed same-page snapshot, then request a fresh evaluation
          // and keep polling while it is in-flight.
          void fetchTabAnalysis(tab.id, activeTabUrl);
          beginAnalysisUpdating();
          requestTabEvaluation(tab.id, (res, reason) => {
            if (reason === 'restricted') {
              showRestrictedPage();
              return;
            }
            if (res?.evalResult?.result && (!activeTabUrl || res.evalResult.result.url === activeTabUrl)) {
              updateTelemetryUI(res.evalResult.result);
            }
            // A null or superseded evaluation response falls back to the
            // stored analysis rather than clearing the view.
            void fetchTabAnalysis(tab.id!, activeTabUrl);
          });
        } else {
          showRestrictedPage();
        }
      } else {
        updateTelemetryUI(undefined, false);
      }
    } catch {
      updateTelemetryUI(undefined, false);
    }
  } else {
    updateTelemetryUI(undefined, false);
  }

  /**
   * Same-document SPA navigations change the tab URL without reloading the
   * page, so the popup's cached activeTabUrl would otherwise pin every URL
   * guard (progress messages, response validity) to the old route. Resync on
   * the tab's URL change and restart the fetch+evaluate cycle for it; the
   * request-generation bump inside fetch/request discards any late responses
   * addressed to the previous URL.
   */
  function handleActiveTabUrlChange(updatedTabId: number, changeInfo: { url?: string }): void {
    if (updatedTabId !== activeTabId || !changeInfo.url || changeInfo.url === activeTabUrl) return;
    const nextUrl = changeInfo.url;
    activeTabUrl = nextUrl;
    displaySnapshot = null;
    currentTabSnapshot = null;
    coverageHold = null;
    renderCloudVerdict(null);
    try {
      const urlObj = new URL(nextUrl);
      domainText.textContent = nextUrl;
      domainText.title = nextUrl;
      currentActiveHostname = urlObj.hostname;
      checkDomainSuppressionState(currentActiveHostname);
    } catch {
      domainText.textContent = nextUrl;
      domainText.title = nextUrl;
      currentActiveHostname = nextUrl;
    }
    if (activeTabId === undefined || !/^https?:\/\//i.test(nextUrl)) {
      showRestrictedPage();
      return;
    }
    beginAnalysisUpdating();
    void fetchTabAnalysis(activeTabId, nextUrl);
    requestTabEvaluation(activeTabId, (res, reason) => {
      if (reason === 'restricted') {
        showRestrictedPage();
        return;
      }
      if (res?.evalResult?.result && res.evalResult.result.url === activeTabUrl) {
        updateTelemetryUI(res.evalResult.result);
      }
      if (activeTabId !== undefined) void fetchTabAnalysis(activeTabId, activeTabUrl);
    });
  }

  if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
    try {
      chrome.tabs.onUpdated.addListener(handleActiveTabUrlChange);
    } catch {}
  }

  function formatWarningTypeDisplay(type?: string): string {
    switch (type) {
      case 'overlay': return 'Full-Screen Overlay';
      case 'banner': return 'Top Warning Banner';
      case 'notification': return 'Notification Toast';
      case 'smart':
      default:
        return 'Smart Adaptive';
    }
  }

  function checkDomainSuppressionState(hostname: string) {
    if (!hostname || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'CHECK_DOMAIN_SUPPRESSION', domain: hostname }, (res) => {
      if (res && res.success) {
        if (res.warningType) {
          if (selectPopupWarningType) selectPopupWarningType.value = res.warningType;
          if (warningModeText) warningModeText.textContent = formatWarningTypeDisplay(res.warningType);
        }
        if (suppressionBanner) {
          if (res.isSnoozed) {
            suppressionBanner.style.display = 'flex';
            if (suppressionStatusTitle) suppressionStatusTitle.textContent = `Protection Snoozed (${res.remainingMinutes}m left)`;
            if (suppressionStatusDesc) suppressionStatusDesc.textContent = `Warnings are snoozed for ${hostname}`;
          } else if (res.isAcknowledged) {
            suppressionBanner.style.display = 'flex';
            if (suppressionStatusTitle) suppressionStatusTitle.textContent = 'Warnings Acknowledged';
            if (suppressionStatusDesc) suppressionStatusDesc.textContent = `Risk acknowledged for ${hostname}`;
          } else {
            suppressionBanner.style.display = 'none';
          }
        }
      }
    });
  }

  if (btnRearmDomain) {
    btnRearmDomain.addEventListener('click', () => {
      if (!currentActiveHostname) return;
      btnRearmDomain.textContent = 'Re-arming...';
      btnRearmDomain.disabled = true;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CLEAR_DOMAIN_SUPPRESSION', domain: currentActiveHostname }, () => {
          setTimeout(() => {
            btnRearmDomain.textContent = 'Re-arm';
            btnRearmDomain.disabled = false;
            if (suppressionBanner) suppressionBanner.style.display = 'none';
            if (activeTabId) {
              if (chrome.tabs?.sendMessage) {
                chrome.tabs.sendMessage(activeTabId, { type: 'CLEAR_SUPPRESSION_DIRECTIVE' });
              }
              if (chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(
                  { type: 'REQUEST_TAB_EVALUATION', tabId: activeTabId, forceVision: false },
                  () => {}
                );
              }
            }
          }, 300);
        });
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['warningType'], (res) => {
      if (res.warningType) {
        if (selectPopupWarningType) selectPopupWarningType.value = res.warningType;
        if (warningModeText) warningModeText.textContent = formatWarningTypeDisplay(res.warningType);
      }
    });
  }

  if (selectPopupWarningType) {
    selectPopupWarningType.addEventListener('change', () => {
      const selected = selectPopupWarningType.value as WarningPresentationType;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'UPDATE_WARNING_CONFIG', config: { warningType: selected } },
          (res) => {
            if (res && res.success) {
              showModelStatusNote(`✓ Alert style set to ${formatWarningTypeDisplay(selected)}`, 'var(--safe)', 2500);
            }
          }
        );
      } else if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ warningType: selected });
      }
    });
  }

  // 2. Load stored analysis state
  function updateTelemetryUI(analysis?: LatestAnalysis, pending = false, updating = false) {
    const signals = analysis?.signals;
    const assessmentInput: AssessmentInput | null = analysis && Number.isFinite(analysis.riskScore)
      ? {
          action: analysis.action,
          riskScore: analysis.riskScore,
          modelStatus: signals?.fused?.modelStatus ?? 'unavailable',
          pageContextAvailable: signals?.fused?.coverage.pageContextAvailable === true,
          topologyScanComplete: signals?.fused?.coverage.topologyScanComplete === true,
          visualAvailable: signals?.fused?.coverage.visualAvailable === true,
        }
      : null;
    let presentation: AssessmentPresentation;
    if (assessmentInput && analysis && !(updating && userInitiatedCheck)) {
      const held = holdSafeDuringRescan(
        assessmentInput,
        `${analysis.pageSessionId ?? ''}|${analysis.navigationGeneration ?? ''}|${analysis.url ?? ''}`,
        Date.parse(analysis.evaluatedAt ?? ''),
        coverageHold
      );
      coverageHold = held.hold;
      presentation = held.presentation;
    } else {
      presentation = presentAssessment(null, pending || updating);
    }
    // While a fresh evaluation is in-flight, the last verdict stays on the
    // badge with a refreshing hint; it is display-only and never used as the
    // current snapshot. A user-initiated re-check keeps CHECKING.
    const refreshing = updating && !!assessmentInput && !userInitiatedCheck;
    const toneClass: Record<typeof presentation.tone, string> = {
      neutral: 'badge-neutral',
      safe: 'badge-safe',
      warning: 'badge-ambiguous',
      block: 'badge-block',
    };
    const toneColor: Record<typeof presentation.tone, string> = {
      neutral: 'var(--text-2)',
      safe: 'var(--safe)',
      warning: 'var(--warn)',
      block: 'var(--block)',
    };

    statusBadge.textContent = presentation.label;
    statusBadge.className = `badge ${toneClass[presentation.tone]}${refreshing ? ' badge-refreshing' : ''}`;
    riskScore.textContent = presentation.scoreText;
    riskScore.style.color = toneColor[presentation.tone];
    meterFill.style.width = presentation.scorePercent === null
      ? '0%'
      : `${Math.min(Math.max(presentation.scorePercent, 3), 100)}%`;
    meterFill.style.backgroundColor = toneColor[presentation.tone];

    if (analysis?.url) {
      domainText.textContent = analysis.url;
      domainText.title = analysis.url;
    }

    if (refreshing) {
      cloudSection?.classList.remove('highlight');
      if (cloudDesc) cloudDesc.textContent = analysisPhaseText;
    } else if (presentation.label === 'BLOCKED') {
      cloudSection?.classList.remove('highlight');
      if (cloudDesc) {
        const reasons = signals?.fused?.reasons?.join(' · ');
        cloudDesc.textContent = reasons
          ? `On-device fused assessment is high risk. Evidence: ${reasons} Cloud verification is optional.`
          : 'On-device fused assessment is high risk. You may optionally request cloud verification.';
      }
    } else if (presentation.label === 'AMBIGUOUS') {
      cloudSection?.classList.add('highlight');
      if (cloudDesc) {
        cloudDesc.textContent = 'On-device fused assessment is ambiguous (15–85). Cloud verification is manual and optional.';
      }
    } else if (presentation.label === 'SAFE') {
      cloudSection?.classList.remove('highlight');
      if (cloudDesc) {
        cloudDesc.textContent = 'This inspection was evaluated on-device. No cloud telemetry was sent. Cloud verification is optional.';
      }
    } else {
      cloudSection?.classList.remove('highlight');
      if (cloudDesc) cloudDesc.textContent = presentation.explanation;
    }

    // Cloud verification applies only to the current completed snapshot —
    // never to the display-only previous values shown while updating.
    const cloudActionDisabled = updating;
    if (btnEscalate) btnEscalate.disabled = cloudActionDisabled;
    if (btnReEscalate) btnReEscalate.disabled = cloudActionDisabled;

    renderSignals(analysis);
  }

  function setCue(key: 'interaction' | 'page' | 'vision', status: 'ok' | 'flag' | 'skipped', text: string) {
    const cue = document.getElementById(`cue-${key}`);
    if (cue) {
      cue.textContent = text;
      const cueClass = status === 'ok' ? 'cue-pill cue-pill-ok' : status === 'flag' ? 'cue-pill cue-pill-flag' : 'cue-pill cue-pill-skip';
      cue.className = cueClass;
    }
  }

  function setSignal(key: 'interaction' | 'page' | 'vision', status: 'ok' | 'flag' | 'skipped', detail: string) {
    const dot = document.getElementById(`sig-${key}-dot`);
    const text = document.getElementById(`sig-${key}-detail`);
    const dotClass = status === 'ok' ? 'sig-ok' : status === 'flag' ? 'sig-flag' : 'sig-skip';
    if (dot) dot.className = `sig-dot ${dotClass}`;
    if (text) text.textContent = detail;
  }

  function getVisionCaptureState(
    vision: ModalityBreakdown['vision'] | undefined,
    visualAvailable: boolean
  ): VisionCaptureState {
    if (visualAvailable || vision?.explainability.available) return 'captured';
    if (vision?.explainability.captureState) {
      return vision.explainability.captureState === 'captured'
        ? 'failed'
        : vision.explainability.captureState;
    }
    switch (vision?.explainability.captureReason) {
      case 'inactive_tab':
      case 'unfocused_window':
      case 'page_changed':
      case 'model_changed':
      case 'capture_api_failure':
      case 'decode_canvas_failure':
      case 'rate_limited':
        return 'pending';
      case 'missing_api':
      case 'restricted_url':
        return 'restricted';
      case 'warning_visible_no_fresh_frame':
        return 'suppressed';
      default:
        return 'failed';
    }
  }

  function visionStateLabel(state: VisionCaptureState): string {
    switch (state) {
      case 'captured': return 'CAPTURED';
      case 'pending': return 'PENDING';
      case 'failed': return 'CAPTURE FAILED';
      case 'restricted': return 'NOT CAPTURABLE';
      case 'suppressed': return 'SUPPRESSED';
      default: return 'CAPTURE FAILED';
    }
  }

  function describeVisionState(
    state: VisionCaptureState,
    vision: ModalityBreakdown['vision'] | undefined
  ): string {
    if (state === 'pending') {
      if (vision?.detail && /pending|retry|waiting/i.test(vision.detail)) return vision.detail;
      if (vision?.explainability.captureReason === 'unfocused_window') {
        return 'Visual capture is pending; restore this browser window or re-evaluate to retry';
      }
      if (vision?.explainability.captureReason === 'inactive_tab') {
        return 'Visual capture is pending; activate this tab or re-evaluate to retry';
      }
      return 'Visual capture is pending; refocus the page or re-evaluate to retry';
    }
    if (state === 'failed') return 'Visual capture failed; page analysis continued';
    if (state === 'restricted') {
      return vision?.detail || 'Visual capture is not permitted for this page';
    }
    if (state === 'suppressed') {
      return 'Visual capture suppressed while the warning is visible; no fresh pre-warning frame is available';
    }
    return vision?.detail || 'Visual frame captured';
  }

  function updateExplainabilityDrawer(analysis?: LatestAnalysis) {
    const signals = analysis?.signals;
    const samples = signals?.interaction.samples ?? analysis?.pointerSamples ?? 0;
    const anomalies = signals?.page.anomalies ?? analysis?.domAnomalies ?? 0;
    const coverage = signals?.fused?.coverage;

    // Vision Stream
    const explainVisionStatus = document.getElementById('explain-vision-status');
    const explainVisionDelta = document.getElementById('explain-vision-delta');
    const explainVisionLayout = document.getElementById('explain-vision-layout');
    if (explainVisionStatus && explainVisionDelta && explainVisionLayout) {
      const visualAvailable = coverage?.visualAvailable ?? signals?.vision.explainability.available ?? false;
      const captureState = analysis
        ? getVisionCaptureState(signals?.vision, visualAvailable)
        : null;
      const visualInFusion = captureState === 'captured' &&
        visualAvailable &&
        signals?.vision.detail === 'Visual input included in fused model evaluation';
      const brandLogoMismatch = signals?.vision.explainability.brandLogoMismatch ?? [];
      const brandLogoReason = signals?.vision.explainability.brandLogoReason ?? null;
      explainVisionStatus.textContent = brandLogoMismatch.length > 0
        ? 'LOGO MISMATCH'
        : !analysis
        ? 'NOT ASSESSED'
        : captureState === 'captured' ? 'CAPTURED'
          : captureState === 'pending' ? 'PENDING'
            : captureState === 'failed' ? 'CAPTURE FAILED'
              : captureState === 'restricted' ? 'NOT CAPTURABLE' : 'SUPPRESSED';
      explainVisionStatus.className = brandLogoMismatch.length > 0
        ? 'explain-badge badge-warn'
        : visualInFusion ? 'explain-badge badge-safe' : 'explain-badge badge-neutral';
      explainVisionDelta.textContent = visualInFusion
        ? 'IN FUSION'
        : captureState === 'captured' && visualAvailable ? 'CAPTURED ONLY'
          : captureState ? visionStateLabel(captureState) : 'NOT ASSESSED';
      const visionLayout = captureState === 'captured' && visualAvailable
        ? visualInFusion
          ? '64×64 RGB frame included in fused model evaluation'
          : '64×64 RGB frame captured but not consumed by the active model'
        : captureState
          ? describeVisionState(captureState, signals?.vision)
          : 'No current page assessment';
      explainVisionLayout.textContent = brandLogoMismatch.length > 0 && brandLogoReason
        ? `${brandLogoReason} · ${visionLayout}`
        : visionLayout;
    }

    // Interaction Stream
    const explainInteractionStatus = document.getElementById('explain-interaction-status');
    const explainInteractionProfile = document.getElementById('explain-interaction-profile');
    const explainInteractionSamples = document.getElementById('explain-interaction-samples');
    if (explainInteractionStatus && explainInteractionProfile && explainInteractionSamples) {
      const trajectoryAvailable = coverage?.trajectoryAvailable ?? signals?.interaction.status === 'ok';
      const validPointCount = coverage?.validPointCount ?? samples;
      const durationMs = coverage?.durationMs ?? 0;
      explainInteractionStatus.textContent = trajectoryAvailable ? 'AVAILABLE' : analysis ? 'INSUFFICIENT' : 'NOT ASSESSED';
      explainInteractionStatus.className = trajectoryAvailable ? 'explain-badge badge-safe' : 'explain-badge badge-neutral';
      explainInteractionProfile.textContent = trajectoryAvailable
        ? `Behavioral coverage · ${Math.round(durationMs)} ms`
        : signals?.interaction.detail ?? (analysis ? 'Behavioral modality unavailable' : 'No current page assessment');
      explainInteractionSamples.textContent = analysis ? `${validPointCount}/128 pts` : '--';
    }

    // Page Stream
    const explainPageStatus = document.getElementById('explain-page-status');
    const explainPageTraps = document.getElementById('explain-page-traps');
    const explainPageOrigin = document.getElementById('explain-page-origin');
    if (explainPageStatus && explainPageTraps && explainPageOrigin) {
      const contextAvailable = coverage?.pageContextAvailable ??
        (signals !== undefined && signals.page.status !== 'skipped');
      const scanComplete = coverage?.topologyScanComplete ?? false;
      const evidenceFound = (signals?.fused?.ruleIds.length ?? anomalies) > 0;
      explainPageStatus.textContent = !contextAvailable
        ? analysis ? 'UNAVAILABLE' : 'NOT ASSESSED'
        : !scanComplete ? 'PARTIAL'
          : evidenceFound ? 'EVIDENCE' : 'NO FINDING';
      explainPageStatus.className = evidenceFound ? 'explain-badge badge-warn' : 'explain-badge badge-neutral';
      explainPageTraps.textContent = analysis ? `${anomalies} policy rules` : '--';
      explainPageOrigin.textContent = signals?.fused?.ruleIds.join(', ') ||
        (analysis ? 'No verified page evidence' : 'No current page assessment');
    }
  }

  function renderSignals(analysis?: LatestAnalysis) {
    if (!analysis) {
      setSignal('interaction', 'skipped', 'No current page assessment');
      setCue('interaction', 'skipped', 'NOT ASSESSED');
      setSignal('page', 'skipped', 'No current tab-scoped page evidence');
      setCue('page', 'skipped', 'NOT ASSESSED');
      setSignal('vision', 'skipped', 'No current tab-scoped visual coverage');
      setCue('vision', 'skipped', 'NOT ASSESSED');
      updateExplainabilityDrawer();
      return;
    }

    const signals = analysis.signals;
    const anomalies = analysis.domAnomalies ?? 0;

    if (signals) {
      setSignal('interaction', signals.interaction.status, signals.interaction.detail);
      setCue(
        'interaction',
        signals.interaction.status,
        `${signals.fused.coverage.validPointCount}/128 PTS`
      );

      setSignal('page', signals.page.status, signals.page.detail);
      setCue(
        'page',
        signals.page.status,
        !signals.fused.coverage.topologyScanComplete
          ? 'PARTIAL'
          : anomalies > 0 ? `${anomalies} RULES` : 'NO FINDING'
      );

      const vStatus = signals.vision.status;
      const visualAvailable = signals.fused.coverage.visualAvailable;
      const captureState = getVisionCaptureState(signals.vision, visualAvailable);
      const visualInFusion = captureState === 'captured' && visualAvailable &&
        signals.vision.detail === 'Visual input included in fused model evaluation';
      if (vStatus === 'flag') {
        const reason = signals.vision.explainability.brandLogoReason ??
          'Displayed logo is not authorized for this host';
        setSignal('vision', 'flag', `${reason} · ${describeVisionState(captureState, signals.vision)}`);
        setCue('vision', 'flag', 'LOGO MISMATCH');
      } else if (vStatus === 'ok' && visualAvailable && captureState === 'captured') {
        setSignal('vision', 'ok', describeVisionState(captureState, signals.vision));
        setCue('vision', 'ok', visualInFusion ? 'IN FUSION' : 'CAPTURED');
      } else {
        setSignal('vision', 'skipped', describeVisionState(captureState, signals.vision));
        const cue = captureState === 'pending' ? 'PENDING'
          : captureState === 'failed' ? 'CAPTURE FAILED'
            : captureState === 'restricted' ? 'NOT CAPTURABLE' : 'SUPPRESSED';
        setCue('vision', 'skipped', cue);
      }

      updateExplainabilityDrawer(analysis);
      return;
    }

    setSignal('interaction', 'skipped', 'No tab-scoped analysis snapshot');
    setCue('interaction', 'skipped', `${analysis.pointerSamples ?? 0} PTS`);

    setSignal('page', 'skipped', 'No tab-scoped page evidence');
    setCue('page', 'skipped', anomalies > 0 ? `${anomalies} RULES` : 'UNAVAILABLE');

    setSignal('vision', 'skipped', 'No tab-scoped visual coverage');
    setCue('vision', 'skipped', 'MISSING');
    updateExplainabilityDrawer(analysis);
  }

  // 3. Render Cloud Verification Verdict UI
  function renderCloudVerdict(verdict: CloudInferenceVerdict | null) {
    if (!verdict) {
      cloudPromptView.style.display = 'block';
      cloudResultView.style.display = 'none';
      cloudIndicator.textContent = 'Not Requested';
      cloudIndicator.className = 'sync-pill sync-pill-offline';
      return;
    }

    cloudPromptView.style.display = 'none';
    cloudResultView.style.display = 'block';
    cloudIndicator.textContent = 'VERIFIED';
    cloudIndicator.className = 'sync-pill sync-pill-online';

    const action = verdict.actionOverride;
    if (action === 'BLOCK') {
      cloudVerdictBox.className = 'cloud-verdict-box verdict-block';
      cloudVerdictTitle.textContent = `BLOCK • ${(verdict.confidence * 100).toFixed(0)}% Confidence`;
    } else if (action === 'WARN') {
      cloudVerdictBox.className = 'cloud-verdict-box verdict-warn';
      cloudVerdictTitle.textContent = `WARN • ${(verdict.confidence * 100).toFixed(0)}% Confidence`;
    } else {
      cloudVerdictBox.className = 'cloud-verdict-box verdict-allow';
      cloudVerdictTitle.textContent = `ALLOW • ${(verdict.confidence * 100).toFixed(0)}% Confidence`;
    }

    if (verdict.targetBrand) {
      cloudBrandRow.style.display = 'flex';
      cloudBrandName.textContent = verdict.targetBrand;
    } else {
      cloudBrandRow.style.display = 'none';
    }

    cloudTeacherVersion.textContent = verdict.teacherModelVersion || 'cloud-evidence-v2';

    cloudReasonsList.innerHTML = '';
    if (verdict.explanationReasons && verdict.explanationReasons.length > 0) {
      for (const reason of verdict.explanationReasons) {
        const li = document.createElement('li');
        li.textContent = reason;
        cloudReasonsList.appendChild(li);
      }
    }
  }

  // 4. Update Model Sync Metadata UI
  function updateModelUI(status?: ModelSyncStatus, runtimeState?: LocalRuntimeState) {
    if (runtimeState) modelRuntimeState = runtimeState;
    const presentation = presentModelRuntime(modelRuntimeState, status);
    const toneClass = presentation.tone === 'online'
      ? 'sync-pill-online'
      : presentation.tone === 'syncing' ? 'sync-pill-syncing' : 'sync-pill-offline';
    modelSyncBadge.textContent = presentation.label;
    modelSyncBadge.className = `sync-pill ${toneClass}`;
    modelSyncBadge.title = presentation.title;
    modelVersionText.textContent = modelRuntimeState === 'ready' &&
      status?.currentVersion && status.currentVersion !== '0.0.0'
      ? `v${status.currentVersion}`
      : modelRuntimeState === 'ready' ? 'LOCAL' : '--';
  }

  function isLocalRuntimeState(value: unknown): value is LocalRuntimeState {
    return value === 'loading' || value === 'ready' || value === 'unavailable';
  }

  function stopModelStatusPolling() {
    if (modelStatusPollTimer !== null) {
      window.clearTimeout(modelStatusPollTimer);
      modelStatusPollTimer = null;
    }
    modelStatusPollStartedAt = null;
  }

  function scheduleModelStatusPoll() {
    if (
      modelRuntimeState !== 'loading' ||
      modelStatusPollTimer !== null ||
      modelStatusPollStartedAt === null ||
      Date.now() - modelStatusPollStartedAt >= 60_000
    ) {
      return;
    }
    modelStatusPollTimer = window.setTimeout(() => {
      modelStatusPollTimer = null;
      requestLiveModelStatus();
    }, 500);
  }

  function requestLiveModelStatus(resetPollWindow = false) {
    if (resetPollWindow || modelStatusPollStartedAt === null) {
      modelStatusPollStartedAt = Date.now();
    }
    if (modelStatusRequestInFlight) return;
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      updateModelUI(undefined, modelRuntimeState);
      scheduleModelStatusPoll();
      return;
    }
    modelStatusRequestInFlight = true;
    try {
      chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' }, (response) => {
        modelStatusRequestInFlight = false;
        const runtimeState = isLocalRuntimeState(response?.runtimeState)
          ? response.runtimeState
          : modelRuntimeState;
        updateModelUI(response?.status, runtimeState);
        if (
          runtimeState === 'ready' &&
          response?.status?.syncState === 'ONLINE_UPDATE_AVAILABLE' &&
          response.status.latestAvailableVersion &&
          response.status.latestAvailableVersion !== response.status.currentVersion
        ) {
          isUpdateAvailablePending = true;
          if (modelUpdateBanner && modelTargetVer && modelCurrentVer) {
            modelTargetVer.textContent = `v${response.status.latestAvailableVersion}`;
            modelCurrentVer.textContent = `v${response.status.currentVersion}`;
            modelUpdateBanner.style.display = 'flex';
          }
          btnSync.textContent = `Hot-swap v${response.status.latestAvailableVersion}`;
        }
        if (runtimeState === 'loading') scheduleModelStatusPoll();
        else stopModelStatusPolling();
      });
    } catch {
      modelStatusRequestInFlight = false;
      updateModelUI(undefined, modelRuntimeState);
      scheduleModelStatusPoll();
    }
  }

  // 5. Update Extension Release / Self-Update UI
  let updateButtonLabel = 'Update';

  function getUpdateButtonLabel(status: ExtensionUpdateStatus): string {
    switch (status.updateChannel) {
      case 'NATIVE':
        return status.nativeUpdateReady ? 'Restart to update' : 'Check now';
      case 'MANUAL_UNPACKED':
        return 'Download zip';
      case 'MANUAL_CRX':
        return 'Download & install (one-time)';
      default:
        return 'Update';
    }
  }

  function updateExtensionUI(status?: ExtensionUpdateStatus) {
    if (!status) return;

    if (extVersionText) {
      extVersionText.textContent = `v${status.currentVersion}`;
    }

    if (status.updateAvailable && updateBanner) {
      updateBanner.style.display = 'flex';
      if (updateTargetVer) updateTargetVer.textContent = `v${status.latestVersion}`;
      if (updateCurrentVer) updateCurrentVer.textContent = `v${status.currentVersion}`;
      updateButtonLabel = getUpdateButtonLabel(status);
      if (btnUpdateNow) {
        btnUpdateNow.textContent = updateButtonLabel;
        if (status.statusMessage) btnUpdateNow.title = status.statusMessage;
      }
    } else if (updateBanner) {
      updateBanner.style.display = 'none';
    }
  }

  // Read initial cached states
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(
      ['modelSyncStatus', 'extensionUpdateStatus'],
      (res) => {
        if (res.extensionUpdateStatus) updateExtensionUI(res.extensionUpdateStatus);
      }
    );
  }

  // Fetch live model status and SQLite inspections from background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    requestLiveModelStatus(true);

    chrome.runtime.sendMessage({ type: 'GET_EXTENSION_UPDATE_STATUS' }, (res) => {
      if (res && res.success && res.status) {
        updateExtensionUI(res.status);
      }
    });
  }


  // 4. Trigger manual evaluation on active tab
  btnInspect.addEventListener('click', async () => {
    userInitiatedCheck = true;
    updateTelemetryUI(undefined, true);
    btnInspect.textContent = 'Evaluating...';
    btnInspect.setAttribute('disabled', 'true');

    const finishInspect = (analysis?: LatestAnalysis, reason?: 'restricted' | 'no_collector') => {
      btnInspect.textContent = 'Re-evaluate Page';
      btnInspect.removeAttribute('disabled');
      if (reason === 'restricted') {
        showRestrictedPage();
        return;
      }
      if (analysis && (!activeTabUrl || analysis.url === activeTabUrl)) {
        updateTelemetryUI(analysis);
      } else if (activeTabId === undefined) {
        updateTelemetryUI(undefined, false);
      }
      // A null or superseded evaluation response falls back to the stored
      // analysis rather than clearing the view.
      if (activeTabId !== undefined) void fetchTabAnalysis(activeTabId, activeTabUrl);
    };

    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
          activeTabUrl = tab.url;
          activeTabId = tab.id;
        }
        const targetTabId = tab?.id;
        if (targetTabId !== undefined) {
          beginAnalysisUpdating();
          requestTabEvaluation(targetTabId, (res, reason) => {
            finishInspect(res?.evalResult?.result ?? undefined, reason);
          });
          return;
        }
      } catch {
        finishInspect();
        return;
      }
    }

    setTimeout(() => {
      finishInspect();
    }, 400);
  });

  function showModelStatusNote(text: string, color = 'var(--safe)', durationMs = 3000) {
    if (!modelStatusNote) return;
    modelStatusNote.textContent = text;
    modelStatusNote.style.color = color;
    modelStatusNote.style.display = 'block';
    setTimeout(() => {
      if (modelStatusNote.textContent === text) {
        modelStatusNote.style.display = 'none';
        modelStatusNote.textContent = '';
      }
    }, durationMs);
  }

  async function triggerModelHotSwap() {
    if (btnHotswapNow) {
      btnHotswapNow.textContent = 'Hot-swapping...';
      btnHotswapNow.disabled = true;
    }
    btnSync.textContent = 'Hot-swapping...';
    btnSync.setAttribute('disabled', 'true');
    updateModelUI(undefined, modelRuntimeState);
    showModelStatusNote(
      modelRuntimeState === 'ready'
        ? 'Model update in progress; the loaded model remains available.'
        : 'Model update in progress',
      'var(--warn)',
      5000
    );

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_LATEST_MODEL' }, (res) => {
        if (res?.status) {
          updateModelUI(
            res.status,
            isLocalRuntimeState(res.runtimeState) ? res.runtimeState : undefined
          );
        }
        requestLiveModelStatus(true);
        setTimeout(() => {
          if (btnHotswapNow) {
            btnHotswapNow.textContent = 'Hot-swap';
            btnHotswapNow.disabled = false;
          }
          btnSync.textContent = 'Check Model Update';
          btnSync.removeAttribute('disabled');
          isUpdateAvailablePending = false;

          if (res && res.success && res.status) {
            if (modelUpdateBanner) modelUpdateBanner.style.display = 'none';
            if (res.updated) {
              showModelStatusNote(`✓ Hot-swapped to v${res.status.currentVersion} successfully!`, 'var(--safe)');
            } else {
              showModelStatusNote(`✓ Model v${res.status.currentVersion} is already up to date!`, 'var(--safe)');
            }
          } else {
            showModelStatusNote(`✕ Hot-swap error: ${res?.error || 'Failed'}`, 'var(--block)');
            btnSync.textContent = 'Retry Hot-swap';
            btnSync.removeAttribute('disabled');
          }
        }, 500);
      });
    }
  }

  if (btnHotswapNow) {
    btnHotswapNow.addEventListener('click', triggerModelHotSwap);
  }

  if (btnDismissModelUpdate && modelUpdateBanner) {
    btnDismissModelUpdate.addEventListener('click', () => {
      modelUpdateBanner.style.display = 'none';
      isUpdateAvailablePending = false;
      btnSync.textContent = 'Check Model Update';
      btnSync.removeAttribute('disabled');
    });
  }

  // 5. Trigger model update check with prompt & hot-swap support
  if (btnCancelSync) {
    btnCancelSync.addEventListener('click', () => {
      isSyncCancelled = true;
      btnCancelSync.style.display = 'none';
      btnSync.textContent = 'Check Model Update';
      btnSync.removeAttribute('disabled');
      updateModelUI(undefined, modelRuntimeState);
    });
  }

  btnSync.addEventListener('click', async () => {
    if (isUpdateAvailablePending) {
      await triggerModelHotSwap();
      return;
    }

    isSyncCancelled = false;
    btnSync.textContent = 'Checking...';
    btnSync.setAttribute('disabled', 'true');
    if (btnCancelSync) btnCancelSync.style.display = 'inline-flex';
    updateModelUI(undefined, modelRuntimeState);
    showModelStatusNote('Checking for model updates...', 'var(--text-2)', 5000);

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CHECK_FOR_UPDATE' }, (res) => {
        setTimeout(() => {
          if (btnCancelSync) btnCancelSync.style.display = 'none';
          if (isSyncCancelled) return;
          const runtimeState = isLocalRuntimeState(res?.runtimeState)
            ? res.runtimeState
            : modelRuntimeState;
          updateModelUI(undefined, runtimeState);

          if (res && res.success && res.updateInfo) {
            const info = res.updateInfo;
            const currentVer = (info.currentVersion || '').replace(/^v/, '').trim();
            const latestVer = (info.latestMetadata?.version || '').replace(/^v/, '').trim();
            const isDifferent = latestVer !== '' && currentVer !== latestVer && currentVer !== '0.0.0';

            if (info.updateAvailable && isDifferent && info.latestMetadata) {
              if (runtimeState === 'ready') {
                // Truly a newer model version available -> notify & show prompt to hotswap
                isUpdateAvailablePending = true;
                if (modelUpdateBanner && modelTargetVer && modelCurrentVer) {
                  modelTargetVer.textContent = `v${info.latestMetadata.version}`;
                  modelCurrentVer.textContent = `v${info.currentVersion}`;
                  modelUpdateBanner.style.display = 'flex';
                }
                btnSync.textContent = `Hot-swap v${info.latestMetadata.version}`;
                btnSync.removeAttribute('disabled');
                showModelStatusNote(`Model v${info.latestMetadata.version} available to hot-swap!`, 'var(--warn)', 4000);
              } else {
                isUpdateAvailablePending = false;
                if (modelUpdateBanner) modelUpdateBanner.style.display = 'none';
                btnSync.textContent = 'Check Model Update';
                btnSync.removeAttribute('disabled');
                showModelStatusNote('The local model is not ready for an update.', 'var(--warn)', 3000);
              }
            } else {
              // Up to date -> notify not available
              isUpdateAvailablePending = false;
              if (modelUpdateBanner) modelUpdateBanner.style.display = 'none';
              btnSync.textContent = 'Up to date';
              showModelStatusNote('✓ Model is up to date (no update available)', 'var(--safe)', 3000);
              setTimeout(() => {
                btnSync.textContent = 'Check Model Update';
                btnSync.removeAttribute('disabled');
              }, 2500);
            }
          } else {
            // Offline or error
            btnSync.textContent = 'Check Model Update';
            btnSync.removeAttribute('disabled');
            showModelStatusNote('⚠ Backend offline — unable to check', 'var(--warn)', 3000);
          }
          requestLiveModelStatus();
        }, 500);
      });
    } else {
      if (btnCancelSync) btnCancelSync.style.display = 'none';
      btnSync.textContent = 'Check Model Update';
      btnSync.removeAttribute('disabled');
    }
  });

  // 6. Extension Update Banner Click Handlers
  if (btnUpdateNow) {
    btnUpdateNow.addEventListener('click', () => {
      btnUpdateNow.textContent = 'Updating...';
      btnUpdateNow.setAttribute('disabled', 'true');
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'INSTALL_EXTENSION_UPDATE' }, (res) => {
          setTimeout(() => {
            if (!res || !res.success) {
              btnUpdateNow.textContent = 'Retry';
            } else if (res.action === 'UPDATE_CHECK_REQUESTED') {
              btnUpdateNow.textContent = 'Check requested';
            } else if (res.action === 'DOWNLOAD_OPENED') {
              btnUpdateNow.textContent = 'Download opened';
            } else {
              btnUpdateNow.textContent = 'Restarting...';
            }
            if (res && res.message) btnUpdateNow.title = res.message;
            setTimeout(() => {
              btnUpdateNow.textContent = updateButtonLabel;
            }, 2500);
            btnUpdateNow.removeAttribute('disabled');
          }, 800);
        });
      }
    });
  }

  if (btnDismissUpdate && updateBanner) {
    btnDismissUpdate.addEventListener('click', () => {
      updateBanner.style.display = 'none';
    });
  }

  // 7. Settings Page Navigation
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open('options/options.html', '_blank');
      }
    });
  }

  // 8. Runtime message listener & storage observer for live update notifications
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'EXTENSION_UPDATE_AVAILABLE' && msg.status) {
        updateExtensionUI(msg.status);
      } else if (
        msg?.type === 'TAB_ANALYSIS_UPDATED' &&
        msg.tabId === activeTabId &&
        msg.url === activeTabUrl
      ) {
        void fetchTabAnalysis(msg.tabId, msg.url);
      } else if (
        msg?.type === 'ANALYSIS_PROGRESS' &&
        msg.tabId === activeTabId &&
        msg.url === activeTabUrl
      ) {
        if (msg.phase === 'completed') {
          void fetchTabAnalysis(msg.tabId, msg.url);
        } else {
          // In-flight pipeline progress for the current page — refresh the
          // display-only updating view with the explicit phase and re-arm
          // the bounded watchdog for the next stage.
          beginAnalysisUpdating(phaseProgressText(String(msg.phase)));
        }
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.modelSyncStatus?.newValue) {
          requestLiveModelStatus();
        }
        if (changes.extensionUpdateStatus?.newValue) {
          updateExtensionUI(changes.extensionUpdateStatus.newValue);
        }
        if (changes.warningType?.newValue) {
          if (selectPopupWarningType) {
            selectPopupWarningType.value = changes.warningType.newValue;
          }
          if (warningModeText) {
            warningModeText.textContent = formatWarningTypeDisplay(changes.warningType.newValue);
          }
        }
      }
    });
  }

  // 9. User-Prompted Cloud Escalation Actions (Completely Optional)
  async function triggerCloudEscalation(btn: HTMLButtonElement) {
    const originalText = btn.textContent;
    btn.textContent = 'Contacting Cloud Verifier...';
    btn.disabled = true;

    let targetTabId: number | undefined;
    let targetUrl = activeTabUrl;
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = activeTab?.id;
      if (activeTab?.url) targetUrl = activeTab.url;
    }
    if (targetTabId === undefined) targetTabId = activeTabId;
    if (targetTabId !== undefined && targetUrl) {
      activeTabId = targetTabId;
      activeTabUrl = targetUrl;
      await fetchTabAnalysis(targetTabId, targetUrl);
    }
    const snapshot = currentTabSnapshot;
    const reference = snapshot ? {
      pageSessionId: snapshot.pageSessionId,
      navigationGeneration: snapshot.navigationGeneration,
      evaluationGeneration: snapshot.evaluationGeneration,
      telemetryId: snapshot.telemetryId,
      url: snapshot.url,
      warningVisible: snapshot.warningVisible,
      topologyScanComplete: snapshot.topologyScanComplete,
    } : undefined;

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'TRIGGER_CLOUD_ESCALATION',
          tabId: targetTabId,
          snapshot: reference,
          includeScreenshot: chkIncludeScreenshot?.checked === true,
        },
        (res) => {
          btn.disabled = false;
          btn.textContent = originalText;
          if (res && res.success && res.verdict) {
            renderCloudVerdict(res.verdict);
          } else if (String(res?.error ?? '').includes('CLOUD_UPGRADE_REQUIRED')) {
            cloudPromptView.style.display = 'block';
            cloudResultView.style.display = 'none';
            cloudIndicator.textContent = 'UPGRADE NEEDED';
            cloudIndicator.className = 'sync-pill sync-pill-offline';
            if (cloudDesc) {
              cloudDesc.textContent = 'This gateway does not support evidence telemetry. No page data was sent; use a compatible cloud verifier.';
            }
          } else {
            alert('Cloud verification could not be completed: ' + (res?.error || 'Backend unreachable'));
          }
        }
      );
    }
  }

  if (btnEscalate) {
    btnEscalate.addEventListener('click', () => triggerCloudEscalation(btnEscalate));
  }

  if (btnReEscalate) {
    btnReEscalate.addEventListener('click', () => triggerCloudEscalation(btnReEscalate));
  }
});

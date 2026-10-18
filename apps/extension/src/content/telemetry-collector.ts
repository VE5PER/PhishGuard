/**
 * PhishGuard Content-Script Telemetry Collector
 *
 * Responsibilities:
 * 1. Passive Pointer Tracking: Samples pointermove/down/up throttled to requestAnimationFrame.
 *    Computes normalized coordinates [0, 1], velocity, acceleration, and angle changes.
 * 2. Keystroke Dynamics: Measures flight times and dwell times without logging raw sensitive
 *    characters (GDPR/PCI-DSS compliant).
 * 3. DOM Listener: Detects clicks on invisible elements (opacity: 0), cross-origin iframe crossings,
 *    and paste actions into password inputs.
 * 4. Warning Overlay: Injects secure warning banner when high-confidence phishing is identified.
 */

import type {
  PointerEventPoint,
  KeystrokeDynamics,
  DOMInteractionEvent,
  InteractionTelemetryPayload,
  KeystrokeCategory,
  WarningPresentationType,
} from '@phishguard/types';
import {
  decideSmartWarningType,
  type ConcreteWarningType,
} from '../warning-config.js';
import { VISION_RECOVERY_DELAYS_MS } from '../background/vision-recovery.js';
import type { VisionUnavailableReason } from '../background/types.js';
import { scanDisplayedBrandLogos } from './displayed-brands.js';
import { randomUuid } from './random-id.js';

const transientVisionReasons: ReadonlySet<VisionUnavailableReason> = new Set([
  'model_changed',
  'capture_api_failure',
  'decode_canvas_failure',
  'rate_limited',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface CollectorEvaluationIdentity {
  pageSessionId: string;
  navigationGeneration: number;
  evaluationGeneration: number;
  url: string;
  telemetryId: string;
  warningVisible: boolean;
  topologyScanComplete: boolean;
  recoveryGeneration: number;
  recoveryAttempt: number;
}

export class TelemetryCollector {
  private pointerSeries: PointerEventPoint[] = [];
  private keystrokes: KeystrokeDynamics[] = [];
  private domEvents: DOMInteractionEvent[] = [];

  private sessionStartTime: number = performance.now();
  private lastPointerTime: number | null = null;
  private lastPointerX: number = 0;
  private lastPointerY: number = 0;
  private lastVelocity: number = 0;
  private isRafScheduled: boolean = false;
  private pendingPointerEvent: MouseEvent | null = null;
  private pointerRafId: number | null = null;
  private totalPointerSamples: number = 0;

  private keyDownTimestamps: Map<KeystrokeCategory, Array<{ downAt: number; flightTime: number }>> = new Map();
  private lastKeyUpTimestamp: number = 0;

  private idleTimer: number | null = null;
  private abortController: AbortController = new AbortController();
  private bannerListener: ((message: {
    type?: string;
    brand?: string | null;
    reasons?: string[];
    warningType?: WarningPresentationType;
    effectiveType?: ConcreteWarningType;
    hasCredentialField?: boolean;
    riskScore?: number;
    snoozeDurationMinutes?: number;
    pageSessionId?: string;
    navigationGeneration?: number;
    evaluationGeneration?: number;
    url?: string;
  }, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void) | null = null;
  private startupTimer: number | null = null;
  private visionRecoveryTimer: number | null = null;
  private focusVisibilityTimer: number | null = null;
  private visionRecoveryAttempt: number = 0;
  private visionRecoveryGeneration: number = 0;
  private destroyed: boolean = false;
  private maxPointerSamples: number = 256;
  private lastDispatchSampleCount: number = 0;
  private pageSessionId: string = randomUuid();
  private navigationGeneration: number = 0;
  private evaluationGeneration: number = 0;
  private evaluationInFlight: Promise<unknown> | null = null;
  private pendingEvaluationIntent: {
    forceVision: boolean;
    visionRecoveryAttempt?: number;
    resolvers: Array<(value: unknown) => void>;
  } | null = null;
  private evidenceIdentities: WeakMap<Element, string> = new WeakMap();
  private evidenceIdentityCounter: number = 0;
  private topologyCandidates: Map<string, {
    overlay: HTMLElement;
    control: HTMLElement;
    event: DOMInteractionEvent;
    firstDetectedAt: number;
    lastValidatedAt: number;
    validationCount: number;
  }> = new Map();
  private topologyScanCursor: number = 0;
  private topologyScanGeneration: number = 0;
  private topologyScanControls: HTMLElement[] = [];
  private topologyScannedControls: Set<HTMLElement> = new Set();
  private topologyFrameCursor: number = 0;
  private topologyScanFrames: HTMLIFrameElement[] = [];
  private topologyScannedFrames: Set<HTMLIFrameElement> = new Set();
  private topologyCoveredControls: Set<HTMLElement> = new Set();
  private topologyCoveredFrames: Set<HTMLIFrameElement> = new Set();
  private topologyRefreshDispatchAt: number = 0;
  private topologyScanComplete: boolean = false;
  private topologyFollowupTimer: number | null = null;
  private topologyRescanTimer: number | null = null;
  private topologyMutationObserver: MutationObserver | null = null;
  private ownedWarningRoots: Map<'overlay' | 'banner' | 'toast', HTMLElement> = new Map();

  private isAcknowledged: boolean = false;
  private snoozedUntil: number = 0;
  private configuredWarningType: WarningPresentationType = 'smart';
  private defaultSnoozeMinutes: number = 15;
  private currentUrl: string = typeof window !== 'undefined' ? window.location.href : '';

  constructor() {
    this.initEventListeners();
    this.initNavigationListeners();
    this.listenForBannerDirectives();
    this.loadSuppressionState().catch(() => {});
    // Proactively evaluate page DOM and visual layout on load with fresh vision capture
    if (typeof window !== 'undefined') {
      if (typeof document !== 'undefined' && (document.readyState === 'complete' || document.readyState === 'interactive')) {
        this.startupTimer = window.setTimeout(() => {
          this.startupTimer = null;
          void this.dispatchTelemetryEvaluation(true, true);
        }, 250);
      } else if (typeof window.addEventListener === 'function') {
        window.addEventListener(
          'DOMContentLoaded',
          () => {
            if (this.destroyed) return;
            this.startupTimer = window.setTimeout(() => {
              this.startupTimer = null;
              void this.dispatchTelemetryEvaluation(true, true);
            }, 250);
          },
          { once: true, signal: this.abortController.signal }
        );
      }
    }
  }

  /**
   * Resets telemetry session and accumulated DOM/pointer state when SPA route changes or page navigates.
   */
  public resetSession(newUrl?: string): void {
    if (newUrl) {
      this.currentUrl = newUrl;
    } else if (typeof window !== 'undefined') {
      this.currentUrl = window.location.href;
    }
    this.navigationGeneration++;
    this.beginVisionRecoveryCycle();
    this.pointerSeries = [];
    this.keystrokes = [];
    this.domEvents = [];
    this.sessionStartTime = performance.now();
    this.lastPointerTime = null;
    this.lastPointerX = 0;
    this.lastPointerY = 0;
    this.lastVelocity = 0;
    this.pendingPointerEvent = null;
    if (this.pointerRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.pointerRafId);
    }
    this.pointerRafId = null;
    this.isRafScheduled = false;
    this.lastDispatchSampleCount = this.totalPointerSamples;
    this.evidenceIdentities = new WeakMap();
    this.evidenceIdentityCounter = 0;
    this.resetTopologyScanProgress();
    this.keyDownTimestamps.clear();
    this.lastKeyUpTimestamp = 0;
    this.removeWarningUI();
    this.loadSuppressionState().catch(() => {});

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    // Proactively trigger fresh evaluation on the newly navigated page layout
    if (typeof window !== 'undefined') {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        void this.dispatchTelemetryEvaluation(true, true, 0);
      }, 150);
    }
  }

  private clearVisionRecoveryTimer(): void {
    if (this.visionRecoveryTimer !== null) {
      clearTimeout(this.visionRecoveryTimer);
      this.visionRecoveryTimer = null;
    }
  }

  private clearFocusVisibilityTimer(): void {
    if (this.focusVisibilityTimer !== null) {
      clearTimeout(this.focusVisibilityTimer);
      this.focusVisibilityTimer = null;
    }
  }

  private beginVisionRecoveryCycle(): number {
    this.clearVisionRecoveryTimer();
    this.clearFocusVisibilityTimer();
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.visionRecoveryAttempt = 0;
    this.visionRecoveryGeneration++;
    return this.visionRecoveryGeneration;
  }

  private resetTopologyScanProgress(): void {
    this.topologyCandidates.clear();
    this.topologyScanCursor = 0;
    this.topologyScanControls = [];
    this.topologyScannedControls.clear();
    this.topologyFrameCursor = 0;
    this.topologyScanFrames = [];
    this.topologyScannedFrames.clear();
    this.topologyCoveredControls.clear();
    this.topologyCoveredFrames.clear();
    this.topologyScanComplete = false;
    this.topologyRefreshDispatchAt = 0;
    this.topologyScanGeneration++;
    if (this.topologyFollowupTimer !== null) clearTimeout(this.topologyFollowupTimer);
    if (this.topologyRescanTimer !== null) clearTimeout(this.topologyRescanTimer);
    this.topologyFollowupTimer = null;
    this.topologyRescanTimer = null;
  }

  private initNavigationListeners(): void {
    if (typeof window === 'undefined') return;

    // 1. Popstate & Hashchange events (back/forward and hash routing)
    const handleUrlChange = () => {
      this.syncNavigation();
    };
    window.addEventListener('popstate', handleUrlChange, { signal: this.abortController.signal });
    window.addEventListener('hashchange', handleUrlChange, { signal: this.abortController.signal });

    // 2. Navigation API: fires for same-document pushState/replaceState
    // navigations. Patching history from a content script cannot observe the
    // page's own calls (isolated world), but the Navigation object is shared
    // across worlds so its events reach this listener.
    try {
      (window as unknown as {
        navigation?: {
          addEventListener?: (type: string, listener: () => void, options?: { signal: AbortSignal }) => void;
        };
      }).navigation?.addEventListener?.(
        'currententrychange',
        handleUrlChange,
        { signal: this.abortController.signal }
      );
    } catch {}
  }

  /**
   * Resets the telemetry session when the document URL moved on without the
   * collector noticing (same-document SPA navigation). Returns true when a
   * reset happened.
   */
  private syncNavigation(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.location.href === this.currentUrl) return false;
    this.resetSession(window.location.href);
    return true;
  }

  private initEventListeners(): void {
    // 1. Throttled Pointer Tracking via requestAnimationFrame
    window.addEventListener(
      'pointermove',
      (e) => {
        this.pendingPointerEvent = e;
        if (!this.isRafScheduled) {
          this.isRafScheduled = true;
          this.pointerRafId = requestAnimationFrame(() => this.processPendingPointerSample('move'));
        }
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.pointerRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this.pointerRafId);
        }
        this.pointerRafId = null;
        this.isRafScheduled = false;
        this.pendingPointerEvent = e;
        this.checkDOMInteraction(e, 'click');
        this.processPendingPointerSample('down');
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    window.addEventListener(
      'pointerup',
      (e) => {
        if (this.pointerRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this.pointerRafId);
        }
        this.pointerRafId = null;
        this.isRafScheduled = false;
        this.pendingPointerEvent = e;
        this.processPendingPointerSample('up');
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    // 2. Privacy-Preserving Keystroke Dynamics (zero character logging)
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.repeat) return;
        const now = performance.now();
        const category = this.categorizeKey(e.key);
        const pending = this.keyDownTimestamps.get(category) ?? [];
        if (pending.length < 128) {
          const flightTime = this.lastKeyUpTimestamp > 0
            ? Math.max(0, now - this.lastKeyUpTimestamp)
            : 0;
          pending.push({ downAt: now, flightTime });
          this.keyDownTimestamps.set(category, pending);
        }
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    window.addEventListener(
      'keyup',
      (e) => {
        const now = performance.now();
        const category = this.categorizeKey(e.key);
        const pending = this.keyDownTimestamps.get(category) ?? [];
        const down = pending.shift();
        if (pending.length === 0) this.keyDownTimestamps.delete(category);

        const dwellTime = down ? Math.max(0, now - down.downAt) : 0;
        const flightTime = down?.flightTime ?? 0;
        this.lastKeyUpTimestamp = now;

        if (this.keystrokes.length < 128) {
          this.keystrokes.push({
            category,
            dwellTimeMs: Math.round(dwellTime),
            flightTimeMs: Math.round(flightTime),
            timestamp: Math.max(0, Math.round(now - this.sessionStartTime)),
          });
        }
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    // 3. DOM Paste & Password Monitoring
    window.addEventListener(
      'paste',
      (e) => {
        this.checkDOMInteraction(e, 'paste');
        this.resetIdleTimer();
      },
      { passive: true, signal: this.abortController.signal }
    );

    const scheduleScan = () => this.requestTopologyRefresh();
    window.addEventListener('scroll', scheduleScan, { passive: true, signal: this.abortController.signal });
    window.addEventListener('resize', scheduleScan, { passive: true, signal: this.abortController.signal });
    const scheduleVisibleRecovery = () => this.scheduleVisibleRecovery();
    window.addEventListener('focus', scheduleVisibleRecovery, { signal: this.abortController.signal });
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', scheduleVisibleRecovery, {
        signal: this.abortController.signal,
      });
    }
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      this.topologyMutationObserver = new MutationObserver(scheduleScan);
      this.topologyMutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['aria-hidden', 'class', 'disabled', 'hidden', 'pointer-events', 'role', 'style', 'tabindex', 'type'],
        childList: true,
        subtree: true,
      });
    }
  }

  private processPendingPointerSample(eventType: 'move' | 'down' | 'up'): void {
    this.isRafScheduled = false;
    this.pointerRafId = null;
    if (this.destroyed || !this.pendingPointerEvent) return;

    const e = this.pendingPointerEvent;
    this.pendingPointerEvent = null;
    const now = Number.isFinite(e.timeStamp) ? e.timeStamp : performance.now();
    const dt = this.lastPointerTime !== null ? now - this.lastPointerTime : 0;

    const viewW = Math.max(window.innerWidth, 1);
    const viewH = Math.max(window.innerHeight, 1);

    const normX = Math.min(Math.max(e.clientX / viewW, 0), 1);
    const normY = Math.min(Math.max(e.clientY / viewH, 0), 1);

    const dx = this.lastPointerTime === null ? 0 : e.clientX - this.lastPointerX;
    const dy = this.lastPointerTime === null ? 0 : e.clientY - this.lastPointerY;
    const dist = Math.hypot(dx, dy);

    const velocity = dt > 0 ? dist / dt : 0;
    const acceleration = dt > 0 ? (velocity - this.lastVelocity) / dt : 0;
    const angle = dist > 0.001 ? Math.atan2(dy, dx) : 0;

    this.lastPointerTime = now;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.lastVelocity = velocity;

    this.pointerSeries.push({
      x: Math.round(normX * 100000) / 100000,
      y: Math.round(normY * 100000) / 100000,
      dx: Math.round(dx * 100) / 100,
      dy: Math.round(dy * 100) / 100,
      velocity: Math.round(velocity * 1000) / 1000,
      acceleration: Math.round(acceleration * 1000) / 1000,
      angle: Math.round(angle * 1000) / 1000,
      timestamp: Math.max(0, Math.round(now - this.sessionStartTime)),
      eventType,
    });
    if (this.pointerSeries.length > this.maxPointerSamples) {
      this.pointerSeries.shift();
    }

    this.totalPointerSamples++;
    // Incrementally count and dispatch on first sample and every 8 samples
    const count = this.totalPointerSamples;
    if (count === 1 || count - this.lastDispatchSampleCount >= 8) {
      this.lastDispatchSampleCount = count;
      this.dispatchTelemetryEvaluation(true);
    }
  }

  private categorizeKey(key: string): KeystrokeCategory {
    if (key === 'Backspace' || key === 'Delete') return 'BACKSPACE';
    if (['Control', 'Shift', 'Alt', 'Meta', 'Enter', 'Tab', 'Escape'].includes(key)) {
      return 'CONTROL';
    }
    if (/^[a-zA-Z0-9]$/.test(key)) return 'ALPHANUMERIC';
    return 'OTHER';
  }

  private checkDOMInteraction(e: Event, interactionType: 'click' | 'paste'): void {
    const target = e.target as HTMLElement | null;
    if (!target?.tagName || this.isExtensionOwned(target)) return;
    const rect = target.getBoundingClientRect();
    const visibility = this.getElementVisibility(target);
    const isZeroOpacity = !visibility.visible || visibility.opacity <= 0.05;
    const isCrossOriginIframe = this.isCrossOriginIframe(target);
    const isPasswordInput = target.tagName.toLowerCase() === 'input' && (target as HTMLInputElement).type === 'password';
    const isPasteIntoPassword = interactionType === 'paste' && isPasswordInput;
    const pointerEvent = e as MouseEvent;
    const interception = interactionType === 'click' &&
      Number.isFinite(pointerEvent.clientX) &&
      Number.isFinite(pointerEvent.clientY)
      ? this.findInterceptingCover(pointerEvent.clientX, pointerEvent.clientY, target)
      : null;

    this.makeDOMEventRoom();
    this.domEvents.push({
      eventType: interactionType,
      targetBoundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      isZeroOpacity,
      isCrossOriginIframe,
      isPasswordInput,
      isPasteIntoPassword,
      elementSelector: this.computeSelectorPath(target),
      timestamp: Math.max(0, Math.round(performance.now() - this.sessionStartTime)),
      evidenceSource: 'observed_interaction',
      evidenceId: this.getEvidenceIdentity(interception?.control ?? target),
      isHitTestIntercepting: interception !== null,
      coveredControlType: interception?.coveredControlType ?? 'none',
      credentialFrameEvidence: isCrossOriginIframe ? 'unverified' : 'none',
    });

    if (this.domEvents.length > 128) this.domEvents.shift();
    if (interception || isCrossOriginIframe || isPasteIntoPassword || isZeroOpacity) {
      this.dispatchTelemetryEvaluation(true);
    }
  }

  /**
   * Proactively scans DOM topology for security anomalies (transparent clickjacking overlays,
   * cross-origin credential frames, etc.) without waiting for user clicks.
   */
  public scanDOMTopology(): DOMInteractionEvent[] {
    const proactiveEvents: DOMInteractionEvent[] = [];
    const scanStartedAt = performance.now();
    const relativeNow = Math.max(0, Math.round(scanStartedAt - this.sessionStartTime));
    let controlsCycleComplete = false;
    let framesCycleComplete = false;

    if (typeof document === 'undefined') {
      this.topologyScanComplete = false;
      return proactiveEvents;
    }

    // 1. Scan for transparent overlays covering interactive elements
    try {
      const controls = Array.from(document.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
      ));
      if (
        controls.length !== this.topologyScanControls.length ||
        controls.some((control, index) => control !== this.topologyScanControls[index])
      ) {
        const present = new Set(controls);
        this.topologyScanControls = controls;
        this.topologyScannedControls.clear();
        for (const covered of this.topologyCoveredControls) {
          if (!present.has(covered)) this.topologyCoveredControls.delete(covered);
        }
        for (const [key, candidate] of this.topologyCandidates) {
          if (!present.has(candidate.control)) this.topologyCandidates.delete(key);
        }
        const firstUncovered = controls.findIndex(
          (control) => !this.topologyCoveredControls.has(control)
        );
        this.topologyScanCursor = Math.max(firstUncovered, 0);
      }
      const startIndex = controls.length ? this.topologyScanCursor % controls.length : 0;
      let index = startIndex;
      let checked = 0;
      const limit = Math.min(controls.length, 500);
      while (checked < limit) {
        if (checked > 0 && performance.now() - scanStartedAt >= 5) break;
        const control = controls[index];
        const covering = this.isVisibleInteractiveControl(control)
          ? this.findInterceptingCoverForControl(control)
          : null;
        const seenKeys = new Set<string>();
        if (covering) {
          const evidenceId = this.getEvidenceIdentity(control);
          const key = `${evidenceId}|${covering.coveredControlType}`;
          seenKeys.add(key);
          const scanTime = performance.now();
          const existing = this.topologyCandidates.get(key);
          const rect = covering.overlay.getBoundingClientRect();
          const event: DOMInteractionEvent = {
            eventType: 'click',
            targetBoundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            isZeroOpacity: true,
            isCrossOriginIframe: false,
            isPasswordInput: false,
            isPasteIntoPassword: false,
            elementSelector: this.computeSelectorPath(covering.overlay),
            timestamp: relativeNow,
            evidenceSource: 'topology_scan',
            evidenceId,
            isHitTestIntercepting: true,
            coveredControlType: covering.coveredControlType,
            credentialFrameEvidence: 'none',
          };
          if (existing && existing.control === control && existing.overlay === covering.overlay) {
            existing.event = event;
            existing.lastValidatedAt = scanTime;
            if (scanTime - existing.firstDetectedAt >= 250) {
              existing.validationCount = Math.max(existing.validationCount, 2);
            }
            if (existing.validationCount < 2) this.scheduleTopologyConfirmation();
          } else {
            this.makeDOMEventRoom();
            if (this.topologyCandidates.size + this.domEvents.length < 128) {
              this.topologyCandidates.set(key, {
                overlay: covering.overlay,
                control,
                event,
                firstDetectedAt: scanTime,
                lastValidatedAt: scanTime,
                validationCount: 1,
              });
              this.scheduleTopologyConfirmation();
            }
          }
        }
        for (const [key, candidate] of this.topologyCandidates) {
          if (candidate.control === control && !seenKeys.has(key)) {
            this.topologyCandidates.delete(key);
          }
        }
        this.topologyScannedControls.add(control);
        this.topologyCoveredControls.add(control);
        checked++;
        index = (index + 1) % controls.length;
        if (index === startIndex) break;
      }
      controlsCycleComplete = this.topologyScannedControls.size >= controls.length;
      this.topologyScanCursor = index;
    } catch {
      controlsCycleComplete = false;
    }

    // 2. Scan for cross-origin iframes on pages with sensitive password inputs
    try {
      const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
      if (
        iframes.length !== this.topologyScanFrames.length ||
        iframes.some((iframe, index) => iframe !== this.topologyScanFrames[index])
      ) {
        const present = new Set(iframes);
        this.topologyScanFrames = iframes;
        this.topologyScannedFrames.clear();
        for (const covered of this.topologyCoveredFrames) {
          if (!present.has(covered)) this.topologyCoveredFrames.delete(covered);
        }
        const firstUncovered = iframes.findIndex(
          (iframe) => !this.topologyCoveredFrames.has(iframe)
        );
        this.topologyFrameCursor = Math.max(firstUncovered, 0);
      }
      const frameStart = iframes.length ? this.topologyFrameCursor % iframes.length : 0;
      let frameIndex = frameStart;
      let checkedFrames = 0;
      const frameLimit = Math.min(iframes.length, 500);
      let foundForeignFrame = false;
      while (checkedFrames < frameLimit) {
        if (performance.now() - scanStartedAt >= 10) {
          break;
        }
        const iframe = iframes[frameIndex];
        if (!foundForeignFrame && this.isCrossOriginIframe(iframe)) {
          foundForeignFrame = true;
          const rect = iframe.getBoundingClientRect();
          proactiveEvents.push({
            eventType: 'click',
            targetBoundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            isZeroOpacity: false,
            isCrossOriginIframe: true,
            isPasswordInput: false,
            isPasteIntoPassword: false,
            elementSelector: this.computeSelectorPath(iframe),
            timestamp: relativeNow,
            evidenceSource: 'topology_scan',
            evidenceId: this.getEvidenceIdentity(iframe),
            isHitTestIntercepting: false,
            coveredControlType: 'none',
            credentialFrameEvidence: 'unverified',
          });
        }
        this.topologyScannedFrames.add(iframe);
        this.topologyCoveredFrames.add(iframe);
        checkedFrames++;
        frameIndex = (frameIndex + 1) % iframes.length;
        if (frameIndex === frameStart) break;
      }
      framesCycleComplete = this.topologyScannedFrames.size >= iframes.length;
      this.topologyFrameCursor = frameIndex;
    } catch {
      framesCycleComplete = false;
    }

    // Sticky coverage: a scan is complete once every current control and
    // frame has been visited at least once on this navigation; re-validation
    // cycles never downgrade it back to incomplete.
    this.topologyScanComplete =
      this.topologyScanControls.every((control) => this.topologyCoveredControls.has(control)) &&
      this.topologyScanFrames.every((iframe) => this.topologyCoveredFrames.has(iframe));
    // First coverage stays fast (50 ms passes); once every current element
    // was scanned, re-validation cycles share the ~1/s refresh throttle so
    // continuously mutating large pages cannot run dispatches forever.
    if (!controlsCycleComplete || !framesCycleComplete) {
      this.scheduleTopologyRescan(this.topologyScanComplete ? this.topologyRefreshDelay() : 50);
    }
    const scanFinishedAt = performance.now();
    for (const [key, candidate] of this.topologyCandidates) {
      if (candidate.overlay.isConnected === false || scanFinishedAt - candidate.lastValidatedAt > 5000) {
        this.topologyCandidates.delete(key);
      } else if (candidate.validationCount >= 2) {
        proactiveEvents.push(candidate.event);
      }
    }
    this.domEvents = this.domEvents.filter((event) => relativeNow - event.timestamp <= 30000).slice(-128);
    return proactiveEvents.slice(0, 128 - this.domEvents.length);
  }

  private computeSelectorPath(el: HTMLElement): string {
    const parts: string[] = [];
    let curr: HTMLElement | null = el;
    while (curr && curr.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      parts.unshift(curr.tagName.toLowerCase());
      curr = curr.parentElement;
    }
    return `${parts.join(' > ') || el.tagName.toLowerCase()}@${this.getEvidenceIdentity(el)}`;
  }

  private getEvidenceIdentity(element: Element): string {
    let identity = this.evidenceIdentities.get(element);
    if (!identity) {
      identity = `d${this.navigationGeneration}_e${++this.evidenceIdentityCounter}`;
      this.evidenceIdentities.set(element, identity);
    }
    return identity;
  }

  private makeDOMEventRoom(): void {
    if (this.topologyCandidates.size + this.domEvents.length < 128) return;
    const oldestCandidate = this.topologyCandidates.keys().next().value;
    if (oldestCandidate !== undefined) {
      this.topologyCandidates.delete(oldestCandidate);
    } else {
      this.domEvents.shift();
    }
  }

  private isExtensionOwned(element: HTMLElement): boolean {
    for (const root of this.ownedWarningRoots.values()) {
      if (root === element || root.contains(element)) return true;
    }
    return false;
  }

  private hasWarningRoot(kind?: 'overlay' | 'banner' | 'toast'): boolean {
    for (const [rootKind, root] of this.ownedWarningRoots) {
      if (root.isConnected === false) {
        this.ownedWarningRoots.delete(rootKind);
      } else if (kind === undefined || kind === rootKind) {
        return true;
      }
    }
    return false;
  }

  private isWarningUIVisible(): boolean {
    for (const root of this.ownedWarningRoots.values()) {
      if (root.isConnected !== false && this.getElementVisibility(root).visible && this.isOnscreen(root)) {
        return true;
      }
    }
    return false;
  }

  private getPageIdentity(): {
    pageSessionId: string;
    navigationGeneration: number;
    evaluationGeneration: number;
    url: string;
    warningVisible: boolean;
    topologyScanComplete: boolean;
  } {
    return {
      pageSessionId: this.pageSessionId,
      navigationGeneration: this.navigationGeneration,
      evaluationGeneration: this.evaluationGeneration,
      url: window.location.href,
      warningVisible: this.isWarningUIVisible(),
      topologyScanComplete: this.topologyScanComplete,
    };
  }

  private isCrossOriginIframe(element: HTMLElement): boolean {
    if (element.tagName.toLowerCase() !== 'iframe') return false;
    const iframe = element as HTMLIFrameElement;
    const src = iframe.getAttribute('src') || iframe.src;
    if (!src) return false;
    try {
      return new URL(src, window.location.href).origin !== window.location.origin;
    } catch {
      return true;
    }
  }

  private isInteractiveControl(element: HTMLElement): boolean {
    const tag = element.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return true;
    const role = element.getAttribute?.('role');
    if (role === 'button' || role === 'link') return true;
    const tabIndex = element.getAttribute?.('tabindex');
    return tabIndex !== null && tabIndex !== undefined && Number(tabIndex) >= 0;
  }

  private getCoveredControlType(element: HTMLElement): 'password' | 'submit' | 'other' | null {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type?.toLowerCase();
      if (type === 'password') return 'password';
      if (type === 'submit' || type === 'image') return 'submit';
      return 'other';
    }
    if (tag === 'button') {
      const type = (element as HTMLButtonElement).type?.toLowerCase();
      if (type === 'submit' || (!type && element.closest?.('form'))) return 'submit';
      return 'other';
    }
    return this.isInteractiveControl(element) ? 'other' : null;
  }

  private isRelatedElement(first: HTMLElement, second: HTMLElement): boolean {
    return first === second || Boolean(first.contains?.(second)) || Boolean(second.contains?.(first));
  }

  private getElementVisibility(element: HTMLElement): { visible: boolean; opacity: number } {
    let opacity = 1;
    let visible = true;
    let current: HTMLElement | null = element;
    let depth = 0;
    while (current && depth++ < 16) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        visible = false;
      }
      const ownOpacity = Number.parseFloat(style.opacity);
      opacity *= Number.isFinite(ownOpacity) ? Math.max(0, Math.min(ownOpacity, 1)) : 1;
      current = current.parentElement;
    }
    return { visible, opacity };
  }

  private isOnscreen(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
      Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
      rect.width > 0 && rect.height > 0 &&
      rect.x < window.innerWidth && rect.y < window.innerHeight &&
      rect.x + rect.width > 0 && rect.y + rect.height > 0;
  }

  private isNativeTransparentControl(element: HTMLElement): boolean {
    if (element.tagName.toLowerCase() !== 'input') return false;
    const type = (element as HTMLInputElement).type?.toLowerCase();
    if (!['checkbox', 'radio', 'file'].includes(type)) return false;
    const style = window.getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    const rect = element.getBoundingClientRect();
    return (Number.isFinite(opacity) && opacity <= 0.05) || rect.width <= 2 || rect.height <= 2;
  }

  private isVisibleInteractiveControl(element: HTMLElement): boolean {
    if (!this.isInteractiveControl(element) || this.isExtensionOwned(element) || !this.isOnscreen(element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const visibility = this.getElementVisibility(element);
    return visibility.visible && visibility.opacity > 0.05 && style.pointerEvents !== 'none' &&
      !this.isNativeTransparentControl(element);
  }

  private isTransparentPositionedHitTarget(element: HTMLElement): boolean {
    if (this.isExtensionOwned(element) || this.isNativeTransparentControl(element) || !this.isOnscreen(element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' ||
      style.pointerEvents === 'none' ||
      !['absolute', 'fixed', 'sticky'].includes(style.position)) {
      return false;
    }
    return this.getElementVisibility(element).opacity <= 0.05;
  }

  private findInterceptingCover(
    x: number,
    y: number,
    observedTarget?: HTMLElement,
    expectedControl?: HTMLElement
  ): { overlay: HTMLElement; control: HTMLElement; coveredControlType: 'password' | 'submit' | 'other' } | null {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const stack = document.elementsFromPoint(x, y) as HTMLElement[];
    const top = stack[0];
    if (!top || (observedTarget && top !== observedTarget)) return null;
    for (let controlIndex = 1; controlIndex < stack.length; controlIndex++) {
      const element = stack[controlIndex];
      if (expectedControl && element !== expectedControl && !expectedControl.contains(element)) continue;
      if (!this.isInteractiveControl(element) || this.isRelatedElement(top, element)) continue;
      const coveredControlType = this.getCoveredControlType(element);
      if (!coveredControlType || !this.isVisibleInteractiveControl(element)) continue;
      for (const hit of stack.slice(0, controlIndex)) {
        const overlay = this.findTransparentPositionedAncestor(hit, element);
        if (
          overlay &&
          (!observedTarget || overlay === observedTarget || overlay.contains(observedTarget))
        ) {
          return { overlay, control: element, coveredControlType };
        }
      }
    }
    return null;
  }

  private findTransparentPositionedAncestor(
    element: HTMLElement,
    coveredControl: HTMLElement
  ): HTMLElement | null {
    let current: HTMLElement | null = element;
    let depth = 0;
    while (current && depth++ < 16) {
      if (!this.isRelatedElement(current, coveredControl) &&
        this.isTransparentPositionedHitTarget(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  private findInterceptingCoverForControl(
    control: HTMLElement
  ): { overlay: HTMLElement; coveredControlType: 'password' | 'submit' | 'other' } | null {
    const rect = control.getBoundingClientRect();
    const insetX = Math.min(2, rect.width / 4);
    const insetY = Math.min(2, rect.height / 4);
    const points: Array<[number, number]> = [
      [rect.x + rect.width / 2, rect.y + rect.height / 2],
      [rect.x + insetX, rect.y + insetY],
      [rect.x + rect.width - insetX, rect.y + insetY],
      [rect.x + insetX, rect.y + rect.height - insetY],
      [rect.x + rect.width - insetX, rect.y + rect.height - insetY],
    ];
    for (const [x, y] of points) {
      const result = this.findInterceptingCover(x, y, undefined, control);
      if (result && (result.control === control || control.contains(result.control))) {
        return { overlay: result.overlay, coveredControlType: result.coveredControlType };
      }
    }
    return null;
  }

  private scheduleVisibleRecovery(): void {
    if (this.destroyed || this.isOrphaned()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.clearVisionRecoveryTimer();
      this.clearFocusVisibilityTimer();
      return;
    }
    const warningVisible = this.isWarningUIVisible();
    if (warningVisible) this.clearVisionRecoveryTimer();
    if (this.focusVisibilityTimer !== null) return;

    const pageSessionId = this.pageSessionId;
    const navigationGeneration = this.navigationGeneration;
    const url = this.currentUrl;
    const recoveryGeneration = this.visionRecoveryGeneration;
    this.focusVisibilityTimer = window.setTimeout(() => {
      this.focusVisibilityTimer = null;
      if (!this.isCurrentRecoveryPage(pageSessionId, navigationGeneration, url, recoveryGeneration, true)) return;
      const warningIsVisible = this.isWarningUIVisible();
      void this.dispatchTelemetryEvaluation(
        true,
        !warningIsVisible,
        warningIsVisible ? this.visionRecoveryAttempt : undefined
      );
    }, 100);
  }

  private scheduleTopologyConfirmation(): void {
    if (this.topologyFollowupTimer !== null || this.destroyed) return;
    const generation = this.topologyScanGeneration;
    this.topologyFollowupTimer = window.setTimeout(() => {
      this.topologyFollowupTimer = null;
      if (this.destroyed || generation !== this.topologyScanGeneration) return;
      this.dispatchTelemetryEvaluation(true);
    }, 250);
  }

  /**
   * Mutation/scroll/resize refresh: clears only the current cycle so the next
   * pass re-validates from the start, while sticky coverage, candidates,
   * topologyScanComplete and the scan generation all survive — confirmation
   * timers keep running and mutating pages can still confirm traps. The
   * dispatch is throttled to about one per second and a pending timer is
   * never restarted, so continuous mutations cannot starve it.
   */
  private topologyRefreshDelay(): number {
    return Math.max(250, 1000 - (performance.now() - this.topologyRefreshDispatchAt));
  }

  private requestTopologyRefresh(): void {
    if (this.destroyed) return;
    this.topologyScannedControls.clear();
    this.topologyScannedFrames.clear();
    this.topologyScanCursor = 0;
    this.topologyFrameCursor = 0;
    this.scheduleTopologyRescan(this.topologyRefreshDelay());
  }

  private scheduleTopologyRescan(delayMs = 100): void {
    if (this.topologyRescanTimer !== null || this.destroyed) return;
    const generation = this.topologyScanGeneration;
    this.topologyRescanTimer = window.setTimeout(() => {
      this.topologyRescanTimer = null;
      if (this.destroyed || generation !== this.topologyScanGeneration) return;
      this.topologyRefreshDispatchAt = performance.now();
      this.dispatchTelemetryEvaluation(true);
    }, delayMs);
  }

  /**
   * True once the extension was reloaded/updated and this content script lost its runtime context.
   */
  public isOrphaned(): boolean {
    if (typeof chrome === 'undefined') return false;
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  /**
   * Removes all listeners and stops sampling so a re-injected script is the only active collector.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visionRecoveryGeneration++;
    this.clearVisionRecoveryTimer();
    this.clearFocusVisibilityTimer();
    this.removeWarningUI();
    this.abortController.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.pendingPointerEvent = null;
    if (this.pointerRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.pointerRafId);
    }
    this.pointerRafId = null;
    this.isRafScheduled = false;
    if (this.topologyFollowupTimer !== null) clearTimeout(this.topologyFollowupTimer);
    if (this.topologyRescanTimer !== null) clearTimeout(this.topologyRescanTimer);
    this.topologyFollowupTimer = null;
    this.topologyRescanTimer = null;
    if (this.pendingEvaluationIntent) {
      const resolvers = this.pendingEvaluationIntent.resolvers;
      this.pendingEvaluationIntent = null;
      resolvers.forEach((resolve) => resolve(null));
    }
    this.topologyMutationObserver?.disconnect();
    this.topologyMutationObserver = null;

    if (this.bannerListener) {
      try {
        if (chrome.runtime?.onMessage) {
          chrome.runtime.onMessage.removeListener(this.bannerListener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
        }
      } catch {
        // Context already invalidated
      }
      this.bannerListener = null;
    }
  }

  private resetIdleTimer(): void {
    if (this.destroyed) return;
    if (this.isOrphaned()) {
      this.destroy();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Dispatch evaluation after 600ms of interaction pause
    this.idleTimer = window.setTimeout(() => {
      this.dispatchTelemetryEvaluation(true);
    }, 600);
  }

  public getTelemetryPayload(): InteractionTelemetryPayload {
    const proactiveEvents = this.scanDOMTopology();
    const allDomEvents = [...this.domEvents, ...proactiveEvents];

    return {
      telemetryId: randomUuid(),
      url: window.location.href,
      domain: window.location.hostname,
      pageTitle: document.title,
      sessionDurationMs: Math.round(performance.now() - this.sessionStartTime),
      pointerSeries: [...this.pointerSeries],
      keystrokes: [...this.keystrokes],
      domEvents: allDomEvents,
      hasCredentialField: !!document.querySelector('input[type="password"]'),
      clientTimestamp: new Date().toISOString(),
    };
  }

  private isCurrentEvaluation(identity: CollectorEvaluationIdentity): boolean {
    return !this.destroyed &&
      !this.isOrphaned() &&
      identity.pageSessionId === this.pageSessionId &&
      identity.navigationGeneration === this.navigationGeneration &&
      identity.evaluationGeneration === this.evaluationGeneration &&
      identity.url === this.currentUrl &&
      identity.url === window.location.href &&
      identity.recoveryGeneration === this.visionRecoveryGeneration;
  }

  private isCurrentRecoveryPage(
    pageSessionId: string,
    navigationGeneration: number,
    url: string,
    recoveryGeneration: number,
    allowWarning = false
  ): boolean {
    return !this.destroyed &&
      !this.isOrphaned() &&
      pageSessionId === this.pageSessionId &&
      navigationGeneration === this.navigationGeneration &&
      url === this.currentUrl &&
      url === window.location.href &&
      recoveryGeneration === this.visionRecoveryGeneration &&
      document.visibilityState !== 'hidden' &&
      (allowWarning || !this.isWarningUIVisible());
  }

  private completeVisionRecovery(identity: CollectorEvaluationIdentity): void {
    if (identity.recoveryGeneration !== this.visionRecoveryGeneration) return;
    this.clearVisionRecoveryTimer();
    this.clearFocusVisibilityTimer();
    this.visionRecoveryAttempt = 0;
    this.visionRecoveryGeneration++;
  }

  private scheduleVisionRecovery(
    identity: CollectorEvaluationIdentity,
    nextAttempt: number
  ): void {
    if (
      this.visionRecoveryTimer !== null ||
      nextAttempt < 1 ||
      nextAttempt > VISION_RECOVERY_DELAYS_MS.length ||
      !this.isCurrentEvaluation(identity) ||
      !this.isCurrentRecoveryPage(
        identity.pageSessionId,
        identity.navigationGeneration,
        identity.url,
        identity.recoveryGeneration
      )
    ) {
      return;
    }

    this.visionRecoveryAttempt = nextAttempt;
    this.visionRecoveryTimer = window.setTimeout(() => {
      this.visionRecoveryTimer = null;
      if (!this.isCurrentRecoveryPage(
        identity.pageSessionId,
        identity.navigationGeneration,
        identity.url,
        identity.recoveryGeneration
      )) {
        return;
      }
      void this.dispatchTelemetryEvaluation(true, true, nextAttempt);
    }, VISION_RECOVERY_DELAYS_MS[nextAttempt - 1]);
  }

  private handleVisionRecoveryResponse(
    response: unknown,
    identity: CollectorEvaluationIdentity
  ): void {
    if (!this.isCurrentEvaluation(identity) || !isRecord(response) || response.success !== true) return;
    const result = isRecord(response.result) ? response.result : null;
    if (
      !result ||
      result.stale === true ||
      result.telemetryId !== identity.telemetryId ||
      result.pageSessionId !== identity.pageSessionId ||
      result.navigationGeneration !== identity.navigationGeneration ||
      result.evaluationGeneration !== identity.evaluationGeneration ||
      result.url !== identity.url ||
      result.warningVisible !== identity.warningVisible ||
      result.topologyScanComplete !== identity.topologyScanComplete
    ) {
      return;
    }
    const signals = isRecord(result.signals) ? result.signals : null;
    const vision = signals && isRecord(signals.vision) ? signals.vision : null;
    const explainability = vision && isRecord(vision.explainability) ? vision.explainability : null;
    if (!explainability) return;

    const captureState = explainability.captureState;
    const reason = explainability.captureReason;
    if (captureState === 'captured' ||
      (captureState === undefined && explainability.available === true)) {
      this.completeVisionRecovery(identity);
      return;
    }
    if (
      this.isWarningUIVisible() ||
      captureState === 'suppressed' ||
      captureState === 'restricted' ||
      captureState === 'failed'
    ) {
      this.clearVisionRecoveryTimer();
      return;
    }
    if (
      captureState === 'pending' &&
      typeof reason === 'string' &&
      transientVisionReasons.has(reason as VisionUnavailableReason) &&
      identity.recoveryAttempt < VISION_RECOVERY_DELAYS_MS.length
    ) {
      this.scheduleVisionRecovery(identity, identity.recoveryAttempt + 1);
      return;
    }
    if (captureState === 'pending') this.clearVisionRecoveryTimer();
  }

  /**
   * One evaluation in-flight plus one pending intent. Concurrent calls
   * coalesce before payload assembly and generation increment; superseded
   * callers share the result of the dispatch that eventually serves the
   * merged intent, so dropped work never allocates a generation that a stale
   * response could misattribute and no caller is resolved with a synthetic
   * null while a serving dispatch is still possible.
   */
  public dispatchTelemetryEvaluation(
    force = false,
    forceVision = false,
    visionRecoveryAttempt?: number
  ): Promise<unknown> {
    if (this.destroyed || this.isOrphaned()) {
      return Promise.resolve(null);
    }
    // Safety net: resync the session if an SPA navigation went unnoticed so
    // the envelope identity below describes the URL actually being sent.
    this.syncNavigation();

    if (this.evaluationInFlight) {
      // Coalesce into the single pending slot: every superseded caller shares
      // the result of the dispatch that eventually serves the merged intent.
      const result = new Promise<unknown>((resolve) => {
        const pending = this.pendingEvaluationIntent;
        if (pending) {
          pending.forceVision = pending.forceVision || forceVision;
          pending.visionRecoveryAttempt = visionRecoveryAttempt ?? pending.visionRecoveryAttempt;
          pending.resolvers.push(resolve);
        } else {
          this.pendingEvaluationIntent = {
            forceVision,
            visionRecoveryAttempt,
            resolvers: [resolve],
          };
        }
      });
      return result;
    }

    const inFlight = this.runTelemetryDispatch(force, forceVision, visionRecoveryAttempt);
    this.evaluationInFlight = inFlight;
    inFlight.then(
      () => this.completeEvaluationDispatch(),
      () => this.completeEvaluationDispatch()
    );
    return inFlight;
  }

  private completeEvaluationDispatch(): void {
    this.evaluationInFlight = null;
    const pending = this.pendingEvaluationIntent;
    this.pendingEvaluationIntent = null;
    if (pending) {
      void this.dispatchTelemetryEvaluation(true, pending.forceVision, pending.visionRecoveryAttempt)
        .then(
          (response) => pending.resolvers.forEach((resolve) => resolve(response)),
          () => pending.resolvers.forEach((resolve) => resolve(null))
        );
    }
  }

  private async runTelemetryDispatch(
    _force = false,
    forceVision = false,
    visionRecoveryAttempt?: number
  ): Promise<unknown> {
    if (this.destroyed || this.isOrphaned()) {
      return null;
    }

    const requestedAttempt = Number.isInteger(visionRecoveryAttempt) &&
      visionRecoveryAttempt !== undefined &&
      visionRecoveryAttempt >= 0 &&
      visionRecoveryAttempt <= VISION_RECOVERY_DELAYS_MS.length
      ? visionRecoveryAttempt
      : undefined;
    if (forceVision && requestedAttempt === undefined) this.beginVisionRecoveryCycle();
    const recoveryAttempt = requestedAttempt ?? this.visionRecoveryAttempt;
    if (requestedAttempt !== undefined) this.visionRecoveryAttempt = requestedAttempt;
    const recoveryGeneration = this.visionRecoveryGeneration;
    const payload = this.getTelemetryPayload();
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const evaluationGeneration = ++this.evaluationGeneration;
      const identity: CollectorEvaluationIdentity = {
        pageSessionId: this.pageSessionId,
        navigationGeneration: this.navigationGeneration,
        evaluationGeneration,
        url: payload.url,
        telemetryId: payload.telemetryId,
        warningVisible: this.isWarningUIVisible(),
        topologyScanComplete: this.topologyScanComplete,
        recoveryGeneration,
        recoveryAttempt,
      };
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            {
              type: 'EVALUATE_TELEMETRY',
              payload,
              forceVision,
              pageSessionId: this.pageSessionId,
              navigationGeneration: this.navigationGeneration,
              evaluationGeneration,
              url: payload.url,
              warningVisible: identity.warningVisible,
              topologyScanComplete: identity.topologyScanComplete,
              displayedBrands: typeof document === 'undefined'
                ? []
                : scanDisplayedBrandLogos(document),
              visionRecoveryAttempt: recoveryAttempt,
            },
            (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
              } else {
                this.handleVisionRecoveryResponse(response, identity);
                resolve(response);
              }
            }
          );
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  public async loadSuppressionState(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    try {
      const stored = await chrome.storage.local.get([
        'warningType',
        'snoozeDurationMinutes',
        'acknowledgedDomains',
        'snoozedDomains',
      ]);
      if (stored.warningType) this.configuredWarningType = stored.warningType;
      if (stored.snoozeDurationMinutes) this.defaultSnoozeMinutes = stored.snoozeDurationMinutes;
      const domain = window.location.hostname;
      if (stored.acknowledgedDomains && stored.acknowledgedDomains[domain]) {
        this.isAcknowledged = true;
      }
      if (stored.snoozedDomains && stored.snoozedDomains[domain]) {
        const until = Number(stored.snoozedDomains[domain]);
        if (until > Date.now()) {
          this.snoozedUntil = until;
        }
      }
    } catch {
      // Ignored
    }
  }

  public isSuppressed(): boolean {
    if (this.isAcknowledged) return true;
    if (this.snoozedUntil > 0) {
      if (Date.now() < this.snoozedUntil) {
        return true;
      }
      this.snoozedUntil = 0;
    }
    return false;
  }

  public acknowledgeWarning(): void {
    this.isAcknowledged = true;
    this.removeWarningUI();
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'ACKNOWLEDGE_DOMAIN',
          domain: window.location.hostname,
        });
      } catch {
        // Extension context might be disconnected
      }
    }
  }

  public snoozeWarning(minutes?: number): void {
    const duration = minutes || this.defaultSnoozeMinutes || 15;
    this.snoozedUntil = Date.now() + duration * 60 * 1000;
    this.removeWarningUI();
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'SNOOZE_DOMAIN',
          domain: window.location.hostname,
          durationMinutes: duration,
        });
      } catch {
        // Extension context might be disconnected
      }
    }
  }

  public removeWarningUI(): void {
    for (const element of this.ownedWarningRoots.values()) {
      element.remove();
    }
    this.ownedWarningRoots.clear();
  }

  private listenForBannerDirectives(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      this.bannerListener = (message: {
        type?: string;
        brand?: string | null;
        reasons?: string[];
        warningType?: WarningPresentationType;
        effectiveType?: ConcreteWarningType;
        hasCredentialField?: boolean;
        riskScore?: number;
        snoozeDurationMinutes?: number;
        pageSessionId?: string;
        navigationGeneration?: number;
        evaluationGeneration?: number;
        url?: string;
      }, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
        if (message.type === 'GET_PAGE_IDENTITY') {
          this.syncNavigation();
          sendResponse(this.getPageIdentity());
          return false;
        }
        if (message.type === 'PAGE_URL_CHANGED') {
          this.syncNavigation();
          return false;
        }
        if (message.type === 'SHOW_PHISHING_BANNER') {
          if (
            message.pageSessionId !== this.pageSessionId ||
            message.navigationGeneration !== this.navigationGeneration ||
            message.evaluationGeneration !== this.evaluationGeneration ||
            message.url !== window.location.href
          ) {
            return false;
          }
          if (this.isSuppressed()) {
            return;
          }
          if (message.snoozeDurationMinutes) {
            this.defaultSnoozeMinutes = message.snoozeDurationMinutes;
          }
          const hasCredential = message.hasCredentialField ?? !!document.querySelector('input[type="password"]');
          const effective = message.effectiveType || decideSmartWarningType(
            message.warningType || this.configuredWarningType,
            { hasCredentialField: hasCredential, riskScore: message.riskScore, reasons: message.reasons }
          );
          this.renderWarning(effective, message.brand, message.reasons);
        } else if (message.type === 'REQUEST_TELEMETRY_EVALUATION') {
          const forceVision = Boolean((message as { forceVision?: boolean }).forceVision);
          this.dispatchTelemetryEvaluation(true, forceVision)
            .then((evalResult) => {
              if (sendResponse) {
                sendResponse({ success: true, count: this.pointerSeries.length, evalResult });
              }
            })
            .catch((err) => {
              if (sendResponse) {
                sendResponse({ success: false, error: String(err) });
              }
            });
          return true; // Keep message channel open for async response
        } else if (message.type === 'CLEAR_SUPPRESSION_DIRECTIVE') {
          this.isAcknowledged = false;
          this.snoozedUntil = 0;
        }
        return false;
      };
      chrome.runtime.onMessage.addListener(this.bannerListener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
    }
  }

  public renderWarning(type: ConcreteWarningType, brand?: string | null, reasons?: string[]): void {
    if (this.isSuppressed()) return;
    this.clearVisionRecoveryTimer();
    if (this.hasWarningRoot()) return;

    if (type === 'overlay') {
      this.renderWarningOverlay(brand, reasons);
    } else if (type === 'banner') {
      this.renderWarningBanner(brand, reasons);
    } else {
      this.renderWarningToast(brand, reasons);
    }
  }

  public renderWarningOverlay(brand?: string | null, reasons?: string[]): void {
    if (this.isSuppressed() || this.hasWarningRoot('overlay')) return;

    const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

    const create = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag);
      node.style.cssText = `all: initial; box-sizing: border-box; font-family: ${FONT}; ${css}`;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const overlay = create('div', `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(8, 9, 10, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    `);
    overlay.id = 'phishguard-warning-overlay';
    this.ownedWarningRoots.set('overlay', overlay);

    const panel = create('div', `
      display: block;
      background: #0E0F11;
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-top: 3px solid #FF5A46;
      border-radius: 16px;
      max-width: 560px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      padding: 32px;
      text-align: left;
      color: #fff;
    `);

    panel.appendChild(create('div', `
      display: block;
      font-family: ${MONO};
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #FF5A46;
      margin-bottom: 12px;
    `, 'PhishGuard \u00b7 Blocked'));

    panel.appendChild(create('h2', `
      display: block;
      font-size: 28px;
      font-weight: 800;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: #fff;
      margin: 0 0 12px;
    `, 'Deceptive Website Detected'));

    panel.appendChild(create('p', `
      display: block;
      font-size: 15px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.62);
      margin: 0 0 16px;
    `, 'PhishGuard blocked this page based on on-device behavioral telemetry and threat verification.'));

    if (brand) {
      panel.appendChild(create('div', `
        display: block;
        background: rgba(255, 90, 70, 0.10);
        border-left: 3px solid #FF5A46;
        padding: 12px 14px;
        margin: 16px 0;
        font-size: 14px;
        font-weight: 600;
        color: #FF8A7A;
      `, `Suspected Brand Impersonation: ${brand}`));
    }

    if (reasons && reasons.length > 0) {
      const list = create('ul', 'display: block; margin: 16px 0; padding: 0; list-style: none;');
      reasons.forEach((reason, index) => {
        list.appendChild(create('li', `
          display: block;
          padding: 10px 0;
          font-size: 13px;
          line-height: 1.45;
          color: rgba(255, 255, 255, 0.62);
          ${index > 0 ? 'border-top: 1px solid rgba(255, 255, 255, 0.08);' : ''}
        `, reason));
      });
      panel.appendChild(list);
    }

    const buttons = create('div', 'display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px;');

    const leaveButton = create('button', `
      display: inline-block;
      background: #FF5A46;
      color: #fff;
      border: none;
      padding: 12px 24px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
    `, 'Leave Site (Recommended)');
    leaveButton.id = 'phishguard-btn-leave';

    const ackButton = create('button', `
      display: inline-block;
      background: transparent;
      color: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.22);
      padding: 12px 20px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    `, 'Acknowledge Risk');
    ackButton.id = 'phishguard-btn-ack';

    const snoozeButton = create('button', `
      display: inline-block;
      background: transparent;
      color: rgba(255, 255, 255, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.14);
      padding: 12px 18px;
      border-radius: 999px;
      font-size: 13px;
      cursor: pointer;
    `, `Snooze (${this.defaultSnoozeMinutes}m)`);
    snoozeButton.id = 'phishguard-btn-snooze';

    // Keep legacy id on ackButton for backward-compatibility with tests looking for phishguard-btn-bypass
    ackButton.setAttribute('data-legacy-id', 'phishguard-btn-bypass');

    buttons.appendChild(leaveButton);
    buttons.appendChild(ackButton);
    buttons.appendChild(snoozeButton);
    panel.appendChild(buttons);
    overlay.appendChild(panel);

    document.body.appendChild(overlay);

    leaveButton.addEventListener('click', () => {
      window.location.href = 'about:blank';
    });

    ackButton.addEventListener('click', () => {
      this.acknowledgeWarning();
    });

    snoozeButton.addEventListener('click', () => {
      this.snoozeWarning();
    });
  }

  public renderWarningBanner(brand?: string | null, reasons?: string[]): void {
    if (this.isSuppressed() || this.hasWarningRoot('banner')) return;

    const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

    const create = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag);
      node.style.cssText = `all: initial; box-sizing: border-box; font-family: ${FONT}; ${css}`;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const banner = create('div', `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      box-sizing: border-box;
      background: #0E0F11;
      border-bottom: 2px solid #FF5A46;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.7);
      z-index: 2147483647;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      color: #fff;
    `);
    banner.id = 'phishguard-warning-banner';
    this.ownedWarningRoots.set('banner', banner);

    const infoSide = create('div', 'display: flex; align-items: center; gap: 14px; flex-wrap: wrap; flex: 1; min-width: 260px;');

    const tag = create('span', `
      display: inline-block;
      font-family: ${MONO};
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      background: #FF5A46;
      color: #fff;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 4px;
    `, 'PHISHGUARD BLOCKED');

    const desc = create('span', 'font-size: 13px; font-weight: 600; color: #fff;');
    const reasonText = reasons && reasons.length > 0 ? reasons[0] : 'Suspicious behavioral anomaly detected';
    desc.textContent = brand
      ? `Suspected ${brand} impersonation on ${window.location.hostname} — ${reasonText}`
      : `Deceptive website detected on ${window.location.hostname} — ${reasonText}`;

    infoSide.appendChild(tag);
    infoSide.appendChild(desc);

    const buttonSide = create('div', 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;');

    const leaveBtn = create('button', `
      display: inline-block;
      background: #FF5A46;
      color: #fff;
      border: none;
      padding: 7px 16px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    `, 'Leave Site');
    leaveBtn.id = 'phishguard-banner-btn-leave';

    const ackBtn = create('button', `
      display: inline-block;
      background: transparent;
      color: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.24);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    `, 'Acknowledge');
    ackBtn.id = 'phishguard-banner-btn-ack';

    const snoozeBtn = create('button', `
      display: inline-block;
      background: transparent;
      color: rgba(255, 255, 255, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.14);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
    `, `Snooze (${this.defaultSnoozeMinutes}m)`);
    snoozeBtn.id = 'phishguard-banner-btn-snooze';

    buttonSide.appendChild(leaveBtn);
    buttonSide.appendChild(ackBtn);
    buttonSide.appendChild(snoozeBtn);

    banner.appendChild(infoSide);
    banner.appendChild(buttonSide);
    document.body.appendChild(banner);

    leaveBtn.addEventListener('click', () => {
      window.location.href = 'about:blank';
    });
    ackBtn.addEventListener('click', () => {
      this.acknowledgeWarning();
    });
    snoozeBtn.addEventListener('click', () => {
      this.snoozeWarning();
    });
  }

  public renderWarningToast(brand?: string | null, reasons?: string[]): void {
    if (this.isSuppressed() || this.hasWarningRoot('toast')) return;

    const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

    const create = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag);
      node.style.cssText = `all: initial; box-sizing: border-box; font-family: ${FONT}; ${css}`;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const toast = create('div', `
      position: fixed;
      top: 18px;
      right: 18px;
      max-width: 400px;
      width: calc(100vw - 36px);
      background: rgba(14, 15, 17, 0.96);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-left: 4px solid #FF5A46;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
      z-index: 2147483647;
      padding: 16px 18px;
      color: #fff;
    `);
    toast.id = 'phishguard-warning-toast';
    this.ownedWarningRoots.set('toast', toast);

    const headRow = create('div', 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;');
    const headTitle = create('span', `
      font-family: ${MONO};
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #FF5A46;
      font-weight: 700;
    `, 'PhishGuard · Threat Alert');

    const closeBtn = create('button', `
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.45);
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      padding: 2px 6px;
    `, '\u00d7');
    closeBtn.id = 'phishguard-toast-btn-close';

    headRow.appendChild(headTitle);
    headRow.appendChild(closeBtn);
    toast.appendChild(headRow);

    const title = create('div', 'font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 6px;');
    title.textContent = brand ? `Suspected ${brand} Impersonation` : 'Deceptive Website Detected';
    toast.appendChild(title);

    const body = create('p', 'font-size: 12px; line-height: 1.45; color: rgba(255, 255, 255, 0.65); margin: 0 0 14px;');
    const reasonText = reasons && reasons.length > 0 ? reasons[0] : 'High-confidence behavioral anomaly on this domain.';
    body.textContent = `${window.location.hostname}: ${reasonText}`;
    toast.appendChild(body);

    const btnRow = create('div', 'display: flex; gap: 8px; flex-wrap: wrap;');

    const leaveBtn = create('button', `
      background: #FF5A46;
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    `, 'Leave Site');
    leaveBtn.id = 'phishguard-toast-btn-leave';

    const ackBtn = create('button', `
      background: transparent;
      color: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.22);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    `, 'Acknowledge');
    ackBtn.id = 'phishguard-toast-btn-ack';

    const snoozeBtn = create('button', `
      background: transparent;
      color: rgba(255, 255, 255, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.14);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      cursor: pointer;
    `, `Snooze (${this.defaultSnoozeMinutes}m)`);
    snoozeBtn.id = 'phishguard-toast-btn-snooze';

    btnRow.appendChild(leaveBtn);
    btnRow.appendChild(ackBtn);
    btnRow.appendChild(snoozeBtn);
    toast.appendChild(btnRow);

    document.body.appendChild(toast);

    leaveBtn.addEventListener('click', () => {
      window.location.href = 'about:blank';
    });
    ackBtn.addEventListener('click', () => {
      this.acknowledgeWarning();
    });
    snoozeBtn.addEventListener('click', () => {
      this.snoozeWarning();
    });
    closeBtn.addEventListener('click', () => {
      this.snoozeWarning(5);
    });
  }
}

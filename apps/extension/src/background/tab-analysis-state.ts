import type { CloudInferenceVerdict, InteractionTelemetryPayload } from '@phishguard/types';
import { CloudInferenceVerdictSchema, InteractionTelemetryPayloadSchema } from '@phishguard/types';
import { z } from 'zod';
import { TabAnalysisRecordSchema, type TabAnalysisRecord } from './types.js';

export interface PageEvaluationEnvelope {
  pageSessionId: string;
  navigationGeneration: number;
  evaluationGeneration: number;
  url: string;
  warningVisible: boolean;
  topologyScanComplete: boolean;
}

export const PageIdentitySchema = z.object({
  pageSessionId: z.string().min(1),
  navigationGeneration: z.number().int().nonnegative(),
  evaluationGeneration: z.number().int().nonnegative(),
  url: z.string().url(),
  warningVisible: z.boolean(),
  topologyScanComplete: z.boolean(),
}).strict();

export type PageIdentity = z.infer<typeof PageIdentitySchema>;

export interface GetTabAnalysisRequest {
  type: 'GET_TAB_ANALYSIS';
  tabId: number;
  url?: string;
}

export interface TabAnalysisSnapshot {
  tabId: number;
  pageSessionId: string;
  navigationGeneration: number;
  evaluationGeneration: number;
  url: string;
  warningVisible: boolean;
  topologyScanComplete: boolean;
  telemetryId: string;
  payload: InteractionTelemetryPayload;
  analysis: TabAnalysisRecord;
  cloudVerdict: CloudInferenceVerdict | null;
  capturedAt: number;
}

export const TabAnalysisSnapshotSchema = z.object({
  tabId: z.number().int().nonnegative(),
  pageSessionId: z.string().min(1),
  navigationGeneration: z.number().int().nonnegative(),
  evaluationGeneration: z.number().int().positive(),
  url: z.string().url(),
  warningVisible: z.boolean(),
  topologyScanComplete: z.boolean(),
  telemetryId: z.string().uuid(),
  payload: InteractionTelemetryPayloadSchema.refine((payload) => !payload.viewportCapture),
  analysis: TabAnalysisRecordSchema,
  cloudVerdict: CloudInferenceVerdictSchema.nullable(),
  capturedAt: z.number().finite().nonnegative(),
}).strict().refine((snapshot) =>
  snapshot.payload.telemetryId === snapshot.telemetryId &&
  snapshot.payload.url === snapshot.url &&
  snapshot.analysis.telemetryId === snapshot.telemetryId &&
  snapshot.analysis.url === snapshot.url &&
  snapshot.analysis.tabId === snapshot.tabId &&
  snapshot.analysis.pageSessionId === snapshot.pageSessionId &&
  snapshot.analysis.navigationGeneration === snapshot.navigationGeneration &&
  snapshot.analysis.evaluationGeneration === snapshot.evaluationGeneration &&
  (snapshot.cloudVerdict === null || snapshot.cloudVerdict.telemetryId === snapshot.telemetryId)
);

interface TabEvaluationState {
  envelope: PageEvaluationEnvelope;
  latestEvaluationGeneration: number;
  snapshot: TabAnalysisSnapshot | null;
  // Display-only copy of the most recent completed analysis on this page
  // identity; never used for strict correctness decisions.
  lastCompleted: TabAnalysisSnapshot | null;
}

interface PendingTask<T> {
  task: () => Promise<T>;
  resolve: (result: T | null) => void;
  reject: (error: unknown) => void;
}

interface QueueState<T> {
  running: boolean;
  pending: PendingTask<T> | null;
}

function samePage(first: PageEvaluationEnvelope, second: PageEvaluationEnvelope): boolean {
  return first.pageSessionId === second.pageSessionId &&
    first.navigationGeneration === second.navigationGeneration &&
    first.url === second.url;
}

function sameSnapshot(first: TabAnalysisSnapshot, second: TabAnalysisSnapshot): boolean {
  return first.tabId === second.tabId &&
    first.pageSessionId === second.pageSessionId &&
    first.navigationGeneration === second.navigationGeneration &&
    first.evaluationGeneration === second.evaluationGeneration &&
    first.url === second.url &&
    first.warningVisible === second.warningVisible &&
    first.topologyScanComplete === second.topologyScanComplete &&
    first.telemetryId === second.telemetryId;
}

export class TabAnalysisStateStore {
  private readonly tabs = new Map<number, TabEvaluationState>();
  private readonly retiredPageSessionIds = new Map<number, Set<string>>();

  public begin(tabId: number, envelope: PageEvaluationEnvelope): boolean {
    let state = this.tabs.get(tabId);
    const retired = this.retiredPageSessionIds.get(tabId);
    if (retired?.has(envelope.pageSessionId)) return false;
    if (
      state &&
      state.envelope.pageSessionId === envelope.pageSessionId &&
      (envelope.navigationGeneration < state.envelope.navigationGeneration ||
        (envelope.navigationGeneration === state.envelope.navigationGeneration &&
          envelope.url !== state.envelope.url))
    ) {
      return false;
    }
    if (!state || !samePage(state.envelope, envelope)) {
      if (state && state.envelope.pageSessionId !== envelope.pageSessionId) {
        this.retire(tabId, state.envelope.pageSessionId);
      }
      state = {
        envelope,
        latestEvaluationGeneration: 0,
        snapshot: null,
        lastCompleted: null,
      };
      this.tabs.set(tabId, state);
    }
    if (!Number.isInteger(envelope.evaluationGeneration) ||
      envelope.evaluationGeneration <= state.latestEvaluationGeneration) {
      return false;
    }
    state.envelope = envelope;
    state.latestEvaluationGeneration = envelope.evaluationGeneration;
    return true;
  }

  public isCurrent(tabId: number, envelope: PageEvaluationEnvelope): boolean {
    const state = this.tabs.get(tabId);
    return !!state &&
      samePage(state.envelope, envelope) &&
      state.latestEvaluationGeneration === envelope.evaluationGeneration;
  }

  public publish(snapshotInput: unknown): boolean {
    const parsed = TabAnalysisSnapshotSchema.safeParse(snapshotInput);
    if (!parsed.success) return false;
    const snapshot = parsed.data;
    const envelope: PageEvaluationEnvelope = snapshot;
    const state = this.tabs.get(snapshot.tabId);
    if (!state || !this.isCurrent(snapshot.tabId, envelope) ||
      snapshot.telemetryId !== snapshot.payload.telemetryId ||
      snapshot.url !== snapshot.payload.url) {
      return false;
    }
    state.snapshot = snapshot;
    state.lastCompleted = snapshot;
    return true;
  }

  public get(tabId: number, url?: string): TabAnalysisSnapshot | null {
    const state = this.tabs.get(tabId);
    const snapshot = state?.snapshot ?? null;
    if (
      !state ||
      !snapshot ||
      !this.isCurrent(tabId, snapshot) ||
      (url !== undefined && snapshot.url !== url)
    ) {
      return null;
    }
    return snapshot;
  }

  /**
   * Display accessor for UI surfaces. Returns the strict current snapshot
   * (current: true) exactly when get() would. Otherwise returns the last
   * completed same-page snapshot with current: false — but only while the
   * tab's page identity (pageSessionId + navigationGeneration + url) still
   * matches and the snapshot was produced by the currently active model.
   * Display-only snapshots are never treated as current anywhere else.
   */
  public getForDisplay(
    tabId: number,
    url: string,
    activeModelHash: string | null
  ): { snapshot: TabAnalysisSnapshot; current: boolean; evaluationPending: boolean } | null {
    const state = this.tabs.get(tabId);
    if (!state) return null;
    const strict = this.get(tabId, url);
    if (strict) {
      return {
        snapshot: strict,
        current: true,
        evaluationPending: state.latestEvaluationGeneration > strict.evaluationGeneration,
      };
    }
    const last = state.lastCompleted;
    if (!last) return null;
    if (
      last.pageSessionId !== state.envelope.pageSessionId ||
      last.navigationGeneration !== state.envelope.navigationGeneration ||
      last.url !== url
    ) {
      return null;
    }
    const snapshotHash = last.analysis.signals.fused.modelHash;
    if (!snapshotHash || !activeModelHash || snapshotHash !== activeModelHash) {
      return null;
    }
    return {
      snapshot: last,
      current: false,
      evaluationPending: state.latestEvaluationGeneration > last.evaluationGeneration,
    };
  }

  public hasTab(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  public restore(snapshotInput: unknown, identityInput: unknown): TabAnalysisSnapshot | null {
    const parsed = TabAnalysisSnapshotSchema.safeParse(snapshotInput);
    const parsedIdentity = PageIdentitySchema.safeParse(identityInput);
    if (!parsed.success || !parsedIdentity.success) return null;
    const snapshot = parsed.data;
    const identity = parsedIdentity.data;
    if (
      snapshot.pageSessionId !== identity.pageSessionId ||
      snapshot.navigationGeneration !== identity.navigationGeneration ||
      snapshot.evaluationGeneration !== identity.evaluationGeneration ||
      snapshot.url !== identity.url
    ) {
      return null;
    }
    if (this.retiredPageSessionIds.get(snapshot.tabId)?.has(snapshot.pageSessionId)) return null;
    const current = this.tabs.get(snapshot.tabId);
    if (
      current &&
      (current.envelope.pageSessionId !== snapshot.pageSessionId ||
        snapshot.navigationGeneration < current.envelope.navigationGeneration ||
        (snapshot.navigationGeneration === current.envelope.navigationGeneration &&
          snapshot.url !== current.envelope.url) ||
        snapshot.evaluationGeneration < current.latestEvaluationGeneration)
    ) {
      return null;
    }
    this.tabs.set(snapshot.tabId, {
      envelope: {
        pageSessionId: snapshot.pageSessionId,
        navigationGeneration: snapshot.navigationGeneration,
        evaluationGeneration: snapshot.evaluationGeneration,
        url: snapshot.url,
        warningVisible: snapshot.warningVisible,
        topologyScanComplete: snapshot.topologyScanComplete,
      },
      latestEvaluationGeneration: snapshot.evaluationGeneration,
      snapshot,
      lastCompleted: snapshot,
    });
    return snapshot;
  }

  public attachCloudVerdict(snapshot: TabAnalysisSnapshot, verdictInput: unknown): boolean {
    const parsedVerdict = CloudInferenceVerdictSchema.safeParse(verdictInput);
    if (!parsedVerdict.success) return false;
    const verdict = parsedVerdict.data;
    const current = this.get(snapshot.tabId);
    if (!current || !sameSnapshot(current, snapshot) ||
      current.telemetryId !== verdict.telemetryId) {
      return false;
    }
    const state = this.tabs.get(snapshot.tabId);
    if (!state) return false;
    state.snapshot = { ...current, cloudVerdict: verdict };
    state.lastCompleted = state.snapshot;
    return true;
  }

  public clearCloudVerdict(snapshot: TabAnalysisSnapshot): boolean {
    const current = this.get(snapshot.tabId);
    if (!current || !sameSnapshot(current, snapshot)) return false;
    const state = this.tabs.get(snapshot.tabId);
    if (!state) return false;
    state.snapshot = { ...current, cloudVerdict: null };
    state.lastCompleted = state.snapshot;
    return true;
  }

  public isCurrentSnapshot(snapshot: TabAnalysisSnapshot): boolean {
    const current = this.get(snapshot.tabId);
    return !!current && sameSnapshot(current, snapshot);
  }

  public invalidate(tabId: number): void {
    const current = this.tabs.get(tabId);
    if (current) this.retire(tabId, current.envelope.pageSessionId);
    this.tabs.delete(tabId);
  }

  public invalidateNavigation(tabId: number): void {
    const current = this.tabs.get(tabId);
    if (current) {
      current.snapshot = null;
      current.lastCompleted = null;
    }
  }

  public forget(tabId: number): void {
    this.tabs.delete(tabId);
    this.retiredPageSessionIds.delete(tabId);
  }

  private retire(tabId: number, pageSessionId: string): void {
    const state = this.tabs.get(tabId);
    if (state?.lastCompleted?.pageSessionId === pageSessionId) {
      state.lastCompleted = null;
    }
    let retired = this.retiredPageSessionIds.get(tabId);
    if (!retired) {
      retired = new Set();
      this.retiredPageSessionIds.set(tabId, retired);
    }
    retired.add(pageSessionId);
    while (retired.size > 128) {
      const oldest = retired.values().next().value as string | undefined;
      if (oldest === undefined) break;
      retired.delete(oldest);
    }
  }
}

export class PerTabLatestQueue<T> {
  private readonly tabs = new Map<number, QueueState<T>>();

  public enqueue(tabId: number, task: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      let state = this.tabs.get(tabId);
      if (!state) {
        state = { running: false, pending: null };
        this.tabs.set(tabId, state);
      }
      const pending = { task, resolve, reject };
      if (state.running) {
        state.pending?.resolve(null);
        state.pending = pending;
        return;
      }
      state.running = true;
      void this.run(tabId, state, pending);
    });
  }

  private async run(
    tabId: number,
    state: QueueState<T>,
    current: PendingTask<T>
  ): Promise<void> {
    try {
      current.resolve(await current.task());
    } catch (error) {
      current.reject(error);
    }
    const next = state.pending;
    state.pending = null;
    if (next) {
      void this.run(tabId, state, next);
    } else {
      this.tabs.delete(tabId);
    }
  }
}

export class PerTabSerialQueue {
  private readonly tails = new Map<number, Promise<unknown>>();

  public run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(tabId, current);
    const clear = () => {
      if (this.tails.get(tabId) === current) this.tails.delete(tabId);
    };
    void current.then(clear, clear);
    return current;
  }

  public async flush(tabId: number): Promise<void> {
    await (this.tails.get(tabId) ?? Promise.resolve()).catch(() => undefined);
  }
}

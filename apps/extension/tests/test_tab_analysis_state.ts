import test from 'node:test';
import assert from 'node:assert/strict';
import type { InteractionTelemetryPayload } from '@phishguard/types';
import {
  PerTabLatestQueue,
  PerTabSerialQueue,
  TabAnalysisStateStore,
  type PageEvaluationEnvelope,
  type TabAnalysisSnapshot,
} from '../src/background/tab-analysis-state.ts';

function envelope(
  pageSessionId: string,
  navigationGeneration: number,
  evaluationGeneration: number,
  url = 'https://example.test/login'
): PageEvaluationEnvelope {
  return {
    pageSessionId,
    navigationGeneration,
    evaluationGeneration,
    url,
    warningVisible: false,
    topologyScanComplete: true,
  };
}

function telemetryId(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function snapshot(tabId: number, page: PageEvaluationEnvelope, telemetryId: string): TabAnalysisSnapshot {
  const payload = {
    telemetryId,
    url: page.url,
    domain: new URL(page.url).hostname,
    pageTitle: '',
    sessionDurationMs: 0,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [],
    hasCredentialField: false,
    clientTimestamp: new Date().toISOString(),
  } as InteractionTelemetryPayload;
  return {
    tabId,
    pageSessionId: page.pageSessionId,
    navigationGeneration: page.navigationGeneration,
    evaluationGeneration: page.evaluationGeneration,
    url: page.url,
    warningVisible: page.warningVisible,
    topologyScanComplete: page.topologyScanComplete,
    telemetryId,
    payload,
    analysis: {
      telemetryId,
      url: page.url,
      domain: payload.domain,
      pageSessionId: page.pageSessionId,
      navigationGeneration: page.navigationGeneration,
      evaluationGeneration: page.evaluationGeneration,
      warningVisible: page.warningVisible,
      topologyScanComplete: page.topologyScanComplete,
      riskScore: 0.05,
      action: 'SAFE',
      evaluatedAt: payload.clientTimestamp,
      modelVersion: 'unavailable',
      pointerSamples: 0,
      keystrokeSamples: 0,
      domAnomalies: 0,
      signals: {
        interaction: {
          score: null,
          status: 'skipped',
          detail: 'Behavioral input unavailable',
          samples: 0,
          explainability: {
            available: false,
            validPointCount: 0,
            durationMs: 0,
            invalidReason: 'empty',
          },
        },
        page: {
          score: 0.05,
          status: 'ok',
          detail: 'No verified page evidence',
          anomalies: 0,
          explainability: { ruleIds: [], reasons: [] },
        },
        vision: {
          score: null,
          status: 'skipped',
          detail: 'Visual input unavailable',
          explainability: { available: false },
        },
        fused: {
          score: 0.05,
          modelScore: null,
          evidenceScore: 0.05,
          modelStatus: 'unavailable',
          modelContract: 'none',
          modelVersion: null,
          modelHash: null,
          inputContractIdentifier: null,
          reasons: [],
          ruleIds: [],
          coverage: {
            trajectoryAvailable: false,
            validPointCount: 0,
            durationMs: 0,
            visualAvailable: false,
            pageContextAvailable: true,
            topologyScanComplete: true,
          },
        },
      },
      canEscalate: true,
      tabId,
    },
    cloudVerdict: null,
    capturedAt: 100,
  };
}

test('tab snapshots isolate same-URL pages and reject stale navigation/evaluation publication', () => {
  const store = new TabAnalysisStateStore();
  const first = envelope('session-a', 0, 1);
  const second = envelope('session-b', 0, 1);

  assert.equal(store.begin(1, first), true);
  assert.equal(store.begin(2, second), true);
  const firstSnapshot = snapshot(1, first, telemetryId(1));
  const secondSnapshot = snapshot(2, second, telemetryId(2));
  assert.equal(store.publish(firstSnapshot), true);
  assert.equal(store.publish(secondSnapshot), true);
  assert.equal(store.get(1)?.telemetryId, telemetryId(1));
  assert.equal(store.get(2)?.telemetryId, telemetryId(2));

  const nextEvaluation = envelope('session-a', 0, 2);
  assert.equal(store.begin(1, nextEvaluation), true);
  assert.equal(store.get(1), null);
  assert.equal(store.publish(firstSnapshot), false);
  assert.equal(store.begin(1, envelope('session-a', 0, 1)), false);
  assert.equal(store.get(2)?.telemetryId, telemetryId(2));

  const nextNavigation = envelope('session-a', 1, 1, 'https://example.test/next');
  assert.equal(store.begin(1, nextNavigation), true);
  assert.equal(store.isCurrent(1, first), false);
});

test('retired page sessions cannot publish after a same-URL document replacement', () => {
  const store = new TabAnalysisStateStore();
  const firstPage = envelope('document-a', 0, 1);
  const secondPage = envelope('document-b', 0, 1);
  assert.equal(store.begin(9, firstPage), true);
  assert.equal(store.publish(snapshot(9, firstPage, telemetryId(3))), true);
  assert.equal(store.begin(9, secondPage), true);
  assert.equal(store.publish(snapshot(9, secondPage, telemetryId(4))), true);
  assert.equal(store.begin(9, envelope('document-a', 0, 2)), false);
  assert.equal(store.get(9)?.telemetryId, telemetryId(4));
});

test('same-URL session restore requires the current page identity', () => {
  const original = snapshot(5, envelope('document-before-reload', 0, 3), telemetryId(5));
  const reloadedIdentity = envelope('document-after-reload', 0, 3);
  const oldDocumentStore = new TabAnalysisStateStore();
  assert.equal(oldDocumentStore.restore(original, reloadedIdentity), null);

  const matchingStore = new TabAnalysisStateStore();
  assert.equal(matchingStore.restore(original, envelope(
    original.pageSessionId,
    original.navigationGeneration,
    original.evaluationGeneration,
    original.url,
  ))?.telemetryId, original.telemetryId);
});

test('cloud verdict attachment requires the exact originating snapshot and telemetry ID', () => {
  const store = new TabAnalysisStateStore();
  const page = envelope('session-c', 0, 1);
  const current = snapshot(4, page, telemetryId(6));
  assert.equal(store.begin(4, page), true);
  assert.equal(store.publish(current), true);
  const verdict = {
    analysisId: '11111111-1111-4111-8111-111111111111',
    telemetryId: current.telemetryId,
    isPhishing: false,
    targetBrand: null,
    confidence: 0.1,
    actionOverride: 'ALLOW',
    explanationReasons: [],
    teacherModelVersion: 'test',
    evaluatedAt: new Date().toISOString(),
  } as const;
  assert.equal(store.attachCloudVerdict(current, verdict), true);
  assert.equal(store.get(4)?.cloudVerdict?.telemetryId, telemetryId(6));
  assert.equal(store.attachCloudVerdict(snapshot(4, page, telemetryId(7)), verdict), false);
  assert.equal(store.clearCloudVerdict(current), true);
  assert.equal(store.get(4)?.cloudVerdict, null);
  assert.equal(store.clearCloudVerdict(snapshot(4, envelope('different-session', 0, 1), telemetryId(6))), false);
});

test('per-tab evaluation queue runs one request and retains only the newest pending request', async () => {
  const queue = new PerTabLatestQueue<number>();
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.enqueue(7, async () => {
    await firstGate;
    return 1;
  });
  const superseded = queue.enqueue(7, async () => 2);
  const latest = queue.enqueue(7, async () => 3);

  assert.equal(await superseded, null);
  releaseFirst?.();
  assert.equal(await first, 1);
  assert.equal(await latest, 3);
});

test('session snapshot removal cannot overtake a newer per-tab publish', async () => {
  const queue = new PerTabSerialQueue();
  const session = new Map<string, string>();
  const operations: string[] = [];
  let releaseWrite: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const previousWrite = queue.run(3, async () => {
    await gate;
    operations.push('old-write');
    session.set('tab-3', 'old');
  });
  const invalidation = queue.run(3, async () => {
    operations.push('invalidate-remove');
    session.delete('tab-3');
  });
  const nextPublish = queue.run(3, async () => {
    operations.push('new-write');
    session.set('tab-3', 'new');
  });

  releaseWrite?.();
  await Promise.all([previousWrite, invalidation, nextPublish]);
  assert.deepEqual(operations, ['old-write', 'invalidate-remove', 'new-write']);
  assert.equal(session.get('tab-3'), 'new');
});

test('display accessor keeps the last completed same-page snapshot while a newer evaluation is pending', () => {
  const store = new TabAnalysisStateStore();
  const hash = 'a'.repeat(64);
  const page = envelope('session-display', 0, 1);
  const completed = snapshot(6, page, telemetryId(10));
  completed.analysis.signals.fused.modelHash = hash;

  assert.equal(store.begin(6, page), true);
  assert.equal(store.publish(completed), true);
  const initial = store.getForDisplay(6, page.url, hash);
  assert.equal(initial?.current, true);
  assert.equal(initial?.evaluationPending, false);
  assert.equal(initial?.snapshot.telemetryId, telemetryId(10));

  // A newer evaluation bumps latestEvaluationGeneration: the strict accessor
  // is empty for the whole pending window, while the completed same-page
  // result stays displayable as non-current.
  const pending = envelope('session-display', 0, 2);
  assert.equal(store.begin(6, pending), true);
  assert.equal(store.get(6), null);
  const display = store.getForDisplay(6, page.url, hash);
  assert.equal(display?.current, false);
  assert.equal(display?.evaluationPending, true);
  assert.equal(display?.snapshot.telemetryId, telemetryId(10));

  // Model-hash mismatch on either side suppresses the display-only snapshot.
  assert.equal(store.getForDisplay(6, page.url, 'b'.repeat(64)), null);
  assert.equal(store.getForDisplay(6, page.url, null), null);

  // A URL mismatch suppresses it too.
  assert.equal(store.getForDisplay(6, 'https://example.test/other', hash), null);

  // Publishing the pending generation restores strict currency.
  const next = snapshot(6, pending, telemetryId(11));
  next.analysis.signals.fused.modelHash = hash;
  assert.equal(store.publish(next), true);
  const refreshed = store.getForDisplay(6, page.url, hash);
  assert.equal(refreshed?.current, true);
  assert.equal(refreshed?.evaluationPending, false);
  assert.equal(refreshed?.snapshot.telemetryId, telemetryId(11));
});

test('display-only snapshots are cleared on page identity, navigation, and invalidation changes', () => {
  const store = new TabAnalysisStateStore();
  const hash = 'c'.repeat(64);
  const page = envelope('session-x', 0, 1);
  const completed = snapshot(8, page, telemetryId(12));
  completed.analysis.signals.fused.modelHash = hash;
  assert.equal(store.begin(8, page), true);
  assert.equal(store.publish(completed), true);

  // A new pageSessionId discards the previous page's display snapshot.
  assert.equal(store.begin(8, envelope('session-y', 0, 1)), true);
  assert.equal(store.getForDisplay(8, page.url, hash), null);

  // A navigation-generation bump on the same session clears it as well.
  const navPage = envelope('session-z', 0, 1, 'https://example.test/a');
  const navCompleted = snapshot(8, navPage, telemetryId(13));
  navCompleted.analysis.signals.fused.modelHash = hash;
  assert.equal(store.begin(8, navPage), true);
  assert.equal(store.publish(navCompleted), true);
  assert.equal(store.begin(8, envelope('session-z', 1, 1, 'https://example.test/b')), true);
  assert.equal(store.getForDisplay(8, 'https://example.test/b', hash), null);

  // invalidateNavigation clears the display-only copy too.
  const revalidated = envelope('session-w', 0, 1, 'https://example.test/c');
  const revalidatedSnapshot = snapshot(8, revalidated, telemetryId(14));
  revalidatedSnapshot.analysis.signals.fused.modelHash = hash;
  assert.equal(store.begin(8, revalidated), true);
  assert.equal(store.publish(revalidatedSnapshot), true);
  store.invalidateNavigation(8);
  assert.equal(store.getForDisplay(8, revalidated.url, hash), null);
});

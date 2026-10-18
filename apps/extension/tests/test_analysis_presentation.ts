import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_HOLD_MS,
  decideFetchAnalysisPresentation,
  holdSafeDuringRescan,
  presentAssessment,
  type AssessmentInput,
} from '../popup/analysis-presentation.ts';

test('missing assessments never display a safety score', () => {
  const checking = presentAssessment(null, true);
  assert.equal(checking.label, 'CHECKING');
  assert.equal(checking.scoreText, '--');
  assert.equal(checking.scorePercent, null);

  const notAssessed = presentAssessment(null);
  assert.equal(notAssessed.label, 'NOT ASSESSED');
  assert.equal(notAssessed.scoreText, '--');
  assert.equal(notAssessed.scorePercent, null);
});

test('an unavailable model and incomplete topology display limited evidence-only assessments', () => {
  const unavailable = presentAssessment({
    action: 'SAFE',
    riskScore: 0.05,
    modelStatus: 'unavailable',
    pageContextAvailable: true,
    topologyScanComplete: true,
  });
  assert.equal(unavailable.label, 'LIMITED');
  assert.equal(unavailable.scoreText, '5%');

  const incomplete = presentAssessment({
    action: 'SAFE',
    riskScore: 0.05,
    modelStatus: 'available',
    pageContextAvailable: true,
    topologyScanComplete: false,
  });
  assert.equal(incomplete.label, 'LIMITED');
  assert.equal(incomplete.explanation, 'The topology scan is incomplete; this result is partial.');
});

test('a ready student-v2 model may assess SAFE with missing vision', () => {
  const presentation = presentAssessment({
    action: 'SAFE',
    riskScore: 0.05,
    modelStatus: 'available',
    modelContract: 'student-v2',
    pageContextAvailable: true,
    topologyScanComplete: true,
    visualAvailable: false,
  });
  assert.equal(presentation.label, 'SAFE');
  assert.equal(presentation.scoreText, '5%');
});

test('actual BLOCK and AMBIGUOUS evidence actions remain visible without model output', () => {
  const blocked = presentAssessment({
    action: 'BLOCK',
    riskScore: 0.9,
    modelStatus: 'unavailable',
    pageContextAvailable: false,
    topologyScanComplete: false,
  });
  assert.equal(blocked.label, 'BLOCKED');

  const ambiguous = presentAssessment({
    action: 'AMBIGUOUS',
    riskScore: 0.4,
    modelStatus: 'unavailable',
    pageContextAvailable: true,
    topologyScanComplete: true,
  });
  assert.equal(ambiguous.label, 'AMBIGUOUS');
});

test('holdSafeDuringRescan keeps a brief SAFE through a topology-only LIMITED on the same page', () => {
  const safeInput: AssessmentInput = {
    action: 'SAFE',
    riskScore: 0.05,
    modelStatus: 'available',
    pageContextAvailable: true,
    topologyScanComplete: true,
  };
  const rescanInput: AssessmentInput = { ...safeInput, topologyScanComplete: false };
  const pageKey = 'sess-1|0|https://example.com/login';

  const first = holdSafeDuringRescan(safeInput, pageKey, 1000, null);
  assert.equal(first.presentation.label, 'SAFE');
  assert.deepEqual(first.hold, { pageKey, safeAt: 1000 });

  const held = holdSafeDuringRescan(rescanInput, pageKey, 3000, first.hold);
  assert.equal(held.presentation.label, 'SAFE');
  assert.equal(held.presentation.tone, 'safe');
  assert.equal(held.presentation.scoreText, '5%');
  assert.equal(
    held.presentation.explanation,
    'Re-scanning newly added page elements; the last complete scan found no risk.'
  );
  assert.equal(held.hold?.safeAt, 1000, 'the hold timestamp is not extended');

  const expired = holdSafeDuringRescan(
    rescanInput,
    pageKey,
    1000 + COVERAGE_HOLD_MS + 1,
    first.hold
  );
  assert.equal(expired.presentation.label, 'LIMITED');

  const otherPage = holdSafeDuringRescan(
    rescanInput,
    'sess-2|0|https://example.com/login',
    2000,
    first.hold
  );
  assert.equal(otherPage.presentation.label, 'LIMITED');

  const noModel = holdSafeDuringRescan(
    { ...rescanInput, modelStatus: 'unavailable' },
    pageKey,
    2000,
    first.hold
  );
  assert.equal(noModel.presentation.label, 'LIMITED');
  const noContext = holdSafeDuringRescan(
    { ...rescanInput, pageContextAvailable: false },
    pageKey,
    2000,
    first.hold
  );
  assert.equal(noContext.presentation.label, 'LIMITED');

  const ambiguous = holdSafeDuringRescan(
    { ...rescanInput, action: 'AMBIGUOUS', riskScore: 0.4 },
    pageKey,
    2000,
    first.hold
  );
  assert.equal(ambiguous.presentation.label, 'AMBIGUOUS');
  assert.equal(ambiguous.hold, null);
  const blocked = holdSafeDuringRescan(
    { ...rescanInput, action: 'BLOCK', riskScore: 0.9 },
    pageKey,
    2000,
    first.hold
  );
  assert.equal(blocked.presentation.label, 'BLOCKED');
  assert.equal(blocked.hold, null);
});

test('fetch analysis presentation decides current, previous, pending, and empty', () => {
  assert.equal(decideFetchAnalysisPresentation(true, true, false), 'current');
  assert.equal(decideFetchAnalysisPresentation(true, undefined, false), 'current');
  assert.equal(decideFetchAnalysisPresentation(true, false, true), 'previous');
  assert.equal(decideFetchAnalysisPresentation(true, false, false), 'previous');
  assert.equal(decideFetchAnalysisPresentation(false, undefined, true), 'pending');
  assert.equal(decideFetchAnalysisPresentation(false, undefined, false), 'empty');
});

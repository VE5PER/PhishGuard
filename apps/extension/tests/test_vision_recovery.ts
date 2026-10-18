import test from 'node:test';
import assert from 'node:assert/strict';
import { presentVisionRecovery, VISION_RECOVERY_DELAYS_MS } from '../src/background/vision-recovery.ts';

test('vision recovery uses the bounded 500ms and 1500ms retry schedule', () => {
  assert.deepEqual(VISION_RECOVERY_DELAYS_MS, [500, 1500]);
  assert.equal(presentVisionRecovery('model_changed', false, 0).captureState, 'pending');
  assert.equal(presentVisionRecovery('capture_api_failure', false, 0).captureState, 'pending');
  assert.equal(presentVisionRecovery('decode_canvas_failure', false, 1).captureState, 'pending');
  assert.equal(presentVisionRecovery('rate_limited', false, 2).captureState, 'failed');
});

test('vision recovery distinguishes event waits, restrictions, warnings, and unclassified failures', () => {
  assert.equal(presentVisionRecovery('inactive_tab', false, 0).captureState, 'pending');
  assert.equal(presentVisionRecovery('unfocused_window', false, 0).captureState, 'pending');
  assert.equal(presentVisionRecovery('page_changed', false, 0).captureState, 'pending');
  assert.equal(presentVisionRecovery('missing_api', false, 0).captureState, 'restricted');
  assert.equal(presentVisionRecovery('restricted_url', false, 0).captureState, 'restricted');
  assert.equal(presentVisionRecovery('warning_visible_no_fresh_frame', false, 0).captureState, 'suppressed');
  assert.equal(presentVisionRecovery(null, false, 0).captureState, 'failed');
  assert.equal(presentVisionRecovery(null, true, 0).captureState, 'captured');
});

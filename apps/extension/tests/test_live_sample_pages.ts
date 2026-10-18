import test from 'node:test';
import assert from 'node:assert/strict';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import type { DOMInteractionEvent, InteractionTelemetryPayload } from '@phishguard/types';

/**
 * Parses static HTML content and applies PhishGuard's proactive DOM topology scanner.
 * Scans for:
 * 1. Transparent elements (opacity: 0, visibility: hidden, deceptive clickjack traps)
 * 2. Cross-origin iframe targets on pages with password inputs
 */
// 1. Scan for transparent clickjacking / honeypot layers
// Detects inline style opacity: 0, CSS IDs with trap/overlay styled with opacity: 0
// Verify whether this element is styled with opacity: 0 in the HTML / CSS
// 2. Scan for cross-origin iframes on credential pages
// Check if domain is external/cross-origin (e.g. example.com vs localhost)

function topologyTrap(
  evidenceId: string,
  coveredControlType: 'password' | 'submit'
): DOMInteractionEvent {
  return {
    eventType: 'click',
    targetBoundingBox: { x: 50, y: 100, width: 380, height: 44 },
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: `div@overlay-${evidenceId}`,
    timestamp: 100,
    evidenceSource: 'topology_scan',
    evidenceId,
    isHitTestIntercepting: true,
    coveredControlType,
    credentialFrameEvidence: 'none',
  };
}

function unverifiedFrame(): DOMInteractionEvent {
  return {
    eventType: 'click',
    targetBoundingBox: { x: 50, y: 200, width: 380, height: 48 },
    isZeroOpacity: false,
    isCrossOriginIframe: true,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'iframe@frame-1',
    timestamp: 150,
    evidenceSource: 'topology_scan',
    evidenceId: 'frame-1',
    isHitTestIntercepting: false,
    coveredControlType: 'none',
    credentialFrameEvidence: 'unverified',
  };
}

function pasteEvent(): DOMInteractionEvent {
  return {
    eventType: 'paste',
    targetBoundingBox: { x: 50, y: 150, width: 380, height: 40 },
    isZeroOpacity: false,
    isCrossOriginIframe: false,
    isPasswordInput: true,
    isPasteIntoPassword: true,
    elementSelector: 'input@control-password',
    timestamp: 500,
    evidenceSource: 'observed_interaction',
    evidenceId: 'control-password',
    isHitTestIntercepting: false,
    coveredControlType: 'none',
    credentialFrameEvidence: 'none',
  };
}

function payload(
  name: string,
  domEvents: DOMInteractionEvent[],
  hasCredentialField: boolean
): InteractionTelemetryPayload {
  return {
    telemetryId: name === 'sample1'
      ? '11111111-1111-4111-8111-111111111111'
      : name === 'sample2'
        ? '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333',
    url: `https://${name}.fixture.test/login`,
    domain: `${name}.fixture.test`,
    pageTitle: name,
    sessionDurationMs: 1000,
    pointerSeries: [],
    keystrokes: [],
    domEvents,
    hasCredentialField,
    clientTimestamp: new Date().toISOString(),
  };
}

test('sample evidence fixtures keep SAFE, AMBIGUOUS, and BLOCK routing without iframe attribution', async () => {
  const engine = new OnDeviceStudentEngine();
  // --- SAMPLE 1: Legitimate SaaS Dashboard (SAFE) ---
  const sample1 = await engine.predictDetailed(payload('sample1', [], false));
  assert.equal(sample1.result.routeAction, 'SAFE');
  assert.equal(sample1.result.clientRiskScore, 0.05);
  assert.equal(sample1.breakdown.page.status, 'ok');

  const trap = topologyTrap('control-submit', 'submit');
  // --- SAMPLE 2: Secondary Verification Gate (AMBIGUOUS) ---
  // Baseline load evaluation (with hidden trap)
  const sample2Load = await engine.predictDetailed(payload('sample2', [trap], true));
  // Simulated Paste into password evaluation
  const sample2Paste = await engine.predictDetailed(payload('sample2', [
    trap,
    pasteEvent(),
    pasteEvent(),
  ], true));
  assert.equal(sample2Load.result.routeAction, 'AMBIGUOUS');
  assert.equal(sample2Paste.result.routeAction, 'AMBIGUOUS');
  assert.equal(sample2Paste.result.clientRiskScore, sample2Load.result.clientRiskScore);
  assert.equal(sample2Paste.breakdown.page.anomalies, 1);

  // --- SAMPLE 3: Hostile Clickjacking & Phishing (BLOCK) ---
  const sample3 = await engine.predictDetailed(payload('sample3', [
    topologyTrap('control-password', 'password'),
    topologyTrap('control-submit', 'submit'),
    unverifiedFrame(),
  ], true));
  assert.equal(sample3.result.routeAction, 'BLOCK');
  assert.equal(sample3.result.clientRiskScore, 0.9);
  assert.equal(sample3.breakdown.page.anomalies, 2);
  assert.deepEqual(
    sample3.breakdown.fused.ruleIds,
    ['intercepting_overlay', 'credential_and_submit_interception'],
  );
  assert.equal(sample3.breakdown.fused.coverage.pageContextAvailable, true);
});

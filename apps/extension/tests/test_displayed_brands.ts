import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDisplayedBrandLogos } from '../src/content/displayed-brands.ts';
import { sanitizeDisplayedBrands } from '../src/background/page-context.ts';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';
import type { DOMInteractionEvent, InteractionTelemetryPayload } from '@phishguard/types';

interface FakeElementSpec {
  tagName: string;
  attrs?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  textContent?: string;
  owner?: FakeElement | null;
}

interface FakeElement {
  tagName: string;
  textContent: string;
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    x: number; y: number; width: number; height: number;
    left: number; top: number; right: number; bottom: number;
    toJSON(): object;
  };
  closest(selector: string): FakeElement | null;
}

function makeElement(spec: FakeElementSpec): FakeElement {
  const rect = spec.rect ?? { x: 10, y: 10, width: 64, height: 24 };
  const element: FakeElement = {
    tagName: spec.tagName.toUpperCase(),
    textContent: spec.textContent ?? '',
    parentElement: spec.owner ?? null,
    getAttribute(name: string) {
      return spec.attrs?.[name] ?? null;
    },
    getBoundingClientRect() {
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON: () => ({}),
      };
    },
    closest(selector: string) {
      if (element.tagName === selector.toUpperCase()) return element;
      return element.parentElement?.closest(selector) ?? null;
    },
  };
  return element;
}

interface FakeDocOptions {
  hasPassword?: boolean;
  bySelector?: Record<string, FakeElement[]>;
  styles?: Map<FakeElement, { display?: string; visibility?: string; opacity?: string }>;
}

function makeDoc(options: FakeDocOptions): Document {
  const styles = options.styles ?? new Map();
  const view = {
    location: { href: 'https://brands.fixture.test/login' },
    getComputedStyle(element: FakeElement) {
      return styles.get(element) ?? { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  return {
    baseURI: 'https://brands.fixture.test/login',
    defaultView: view,
    querySelector: (selector: string) =>
      selector === 'input[type="password"]' && options.hasPassword !== false
        ? makeElement({ tagName: 'input' })
        : null,
    querySelectorAll: (selector: string) => options.bySelector?.[selector] ?? [],
  } as unknown as Document;
}

test('displayed brand scanner reports a visible PayPal svg logo on a password page', () => {
  const svg = makeElement({ tagName: 'svg', attrs: { 'aria-label': 'PayPal' } });
  const doc = makeDoc({ bySelector: { 'svg[aria-label]': [svg] } });
  assert.deepEqual(scanDisplayedBrandLogos(doc), ['paypal']);
});

test('displayed brand scanner ignores logos when no password field exists', () => {
  const svg = makeElement({ tagName: 'svg', attrs: { 'aria-label': 'PayPal' } });
  const doc = makeDoc({ hasPassword: false, bySelector: { 'svg[aria-label]': [svg] } });
  assert.deepEqual(scanDisplayedBrandLogos(doc), []);
});

test('displayed brand scanner ignores transparent logo decoys', () => {
  const svg = makeElement({ tagName: 'svg', attrs: { 'aria-label': 'PayPal' } });
  const styles = new Map([[svg, { opacity: '0' }]]);
  const doc = makeDoc({ bySelector: { 'svg[aria-label]': [svg] }, styles });
  assert.deepEqual(scanDisplayedBrandLogos(doc), []);
});

test('displayed brand scanner ignores unrelated image filenames', () => {
  const img = makeElement({ tagName: 'img', attrs: { src: '/img/pineapple.png' } });
  const doc = makeDoc({ bySelector: { 'img[src]': [img] } });
  assert.deepEqual(scanDisplayedBrandLogos(doc), []);
});

test('displayed brand scanner matches multi-word brand names in alt text', () => {
  const img = makeElement({ tagName: 'img', attrs: { alt: 'Bank of America' } });
  const doc = makeDoc({ bySelector: { 'img[alt]': [img] } });
  assert.deepEqual(scanDisplayedBrandLogos(doc), ['bankofamerica']);
});

test('displayed brand scanner reads svg title text with visibility on the owning svg', () => {
  const svg = makeElement({ tagName: 'svg' });
  const title = makeElement({ tagName: 'title', textContent: 'PayPal', owner: svg });
  const doc = makeDoc({ bySelector: { 'svg title': [title] } });
  assert.deepEqual(scanDisplayedBrandLogos(doc), ['paypal']);
});

test('sanitizeDisplayedBrands keeps only unique known brand keys, sorted and capped', () => {
  assert.deepEqual(
    sanitizeDisplayedBrands(['paypal', 'paypal', '<script>', 'notabrand', 5]),
    ['paypal']
  );
  assert.deepEqual(
    sanitizeDisplayedBrands(['microsoft', 'apple', 'paypal', 'google', 'dhl', 'chase']),
    ['apple', 'chase', 'dhl', 'google']
  );
  assert.deepEqual(sanitizeDisplayedBrands('paypal'), []);
  assert.deepEqual(sanitizeDisplayedBrands(null), []);
  assert.deepEqual(sanitizeDisplayedBrands(undefined), []);
});

function submitTrap(): DOMInteractionEvent {
  return {
    eventType: 'click',
    targetBoundingBox: { x: 50, y: 100, width: 380, height: 44 },
    isZeroOpacity: true,
    isCrossOriginIframe: false,
    isPasswordInput: false,
    isPasteIntoPassword: false,
    elementSelector: 'div@overlay-control-submit',
    timestamp: 100,
    evidenceSource: 'topology_scan',
    evidenceId: 'control-submit',
    isHitTestIntercepting: true,
    coveredControlType: 'submit',
    credentialFrameEvidence: 'none',
  };
}

function sample2Payload(url = 'https://sample2.fixture.test/login'): InteractionTelemetryPayload {
  return {
    telemetryId: '22222222-2222-4222-8222-222222222222',
    url,
    domain: new URL(url).hostname,
    pageTitle: 'sample2',
    sessionDurationMs: 1000,
    pointerSeries: [],
    keystrokes: [],
    domEvents: [submitTrap()],
    hasCredentialField: true,
    clientTimestamp: new Date().toISOString(),
  };
}

test('displayed brand logos flag the vision modality without touching fused scoring', async () => {
  const engine = new OnDeviceStudentEngine();
  const payload = sample2Payload();
  const baseline = await engine.predictDetailed(payload, null, {});
  const flagged = await engine.predictDetailed(payload, null, { displayedBrands: ['paypal'] });

  assert.equal(flagged.breakdown.vision.status, 'flag');
  assert.deepEqual(flagged.breakdown.vision.explainability.brandLogoMismatch, ['paypal']);
  assert.match(
    flagged.breakdown.vision.explainability.brandLogoReason ?? '',
    /PayPal logo is not authorized for sample2\.fixture\.test/
  );
  assert.equal(flagged.breakdown.vision.detail, baseline.breakdown.vision.detail);
  assert.equal(flagged.result.clientRiskScore, baseline.result.clientRiskScore);
  assert.equal(flagged.result.routeAction, baseline.result.routeAction);
  assert.deepEqual(flagged.breakdown.fused.ruleIds, baseline.breakdown.fused.ruleIds);
  assert.deepEqual(flagged.breakdown.fused.reasons, baseline.breakdown.fused.reasons);
  assert.equal(flagged.breakdown.page.anomalies, baseline.breakdown.page.anomalies);
});

test('displayed brand logos are not flagged on authorized brand hosts', async () => {
  const engine = new OnDeviceStudentEngine();
  const payload = sample2Payload('https://www.paypal.com/signin');
  const result = await engine.predictDetailed(payload, null, { displayedBrands: ['paypal'] });
  assert.notEqual(result.breakdown.vision.status, 'flag');
  assert.deepEqual(result.breakdown.vision.explainability.brandLogoMismatch, []);
  assert.equal(result.breakdown.vision.explainability.brandLogoReason, null);
});

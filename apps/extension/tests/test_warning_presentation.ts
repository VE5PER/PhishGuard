import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSmartWarningType,
} from '../src/warning-config.ts';
import {
  isDomainSuppressed,
  acknowledgeDomain,
  snoozeDomain,
  clearDomainSuppression,
  clearAllSuppressions,
} from '../src/background/service-worker.ts';
import { TelemetryCollector } from '../src/content/telemetry-collector.ts';

test('decideSmartWarningType adheres to explicit configuration', () => {
  assert.equal(decideSmartWarningType('overlay', { hasCredentialField: false, riskScore: 0.1 }), 'overlay');
  assert.equal(decideSmartWarningType('banner', { hasCredentialField: true, riskScore: 0.99 }), 'banner');
  assert.equal(decideSmartWarningType('notification', { hasCredentialField: true, riskScore: 0.99 }), 'notification');
});

test('decideSmartWarningType makes smart decisions based on credentials and risk severity', () => {
  // 1. Password/credential field present -> overlay (essential to prevent typing passwords)
  assert.equal(
    decideSmartWarningType('smart', { hasCredentialField: true, riskScore: 0.86 }),
    'overlay'
  );

  // 2. Critical risk probability (>= 0.90) without password field -> overlay
  assert.equal(
    decideSmartWarningType('smart', { hasCredentialField: false, riskScore: 0.95 }),
    'overlay'
  );

  // 3. Behavioral anomaly without password solicitation (0.85 - 0.89) -> banner
  assert.equal(
    decideSmartWarningType('smart', { hasCredentialField: false, riskScore: 0.87 }),
    'banner'
  );

  // 4. Moderate/ambient risk (< 0.85) -> notification toast
  assert.equal(
    decideSmartWarningType('smart', { hasCredentialField: false, riskScore: 0.70 }),
    'notification'
  );
});

test('service-worker suppression management (ack, snooze, clear)', async () => {
  const fakeStorage: Record<string, unknown> = {};
  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const res: Record<string, unknown> = {};
          keys.forEach((k) => {
            if (fakeStorage[k] !== undefined) res[k] = fakeStorage[k];
          });
          return res;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(fakeStorage, items);
        },
      },
    },
    notifications: {
      create: (_id: string, _options: any) => {},
    },
  };

  try {
    // Initial state: not suppressed
    assert.equal(await isDomainSuppressed('login-phish.xyz'), false);

    // Acknowledge domain
    await acknowledgeDomain('login-phish.xyz');
    assert.equal(await isDomainSuppressed('login-phish.xyz'), true);

    // Clear domain suppression
    await clearDomainSuppression('login-phish.xyz');
    assert.equal(await isDomainSuppressed('login-phish.xyz'), false);

    // Snooze domain for 15 minutes
    const snoozeUntil = await snoozeDomain('bank-fake.org', 15);
    assert.ok(snoozeUntil > Date.now());
    assert.equal(await isDomainSuppressed('bank-fake.org'), true);

    // Expired snooze is not suppressed
    fakeStorage.snoozedDomains = { 'expired.com': Date.now() - 1000 };
    assert.equal(await isDomainSuppressed('expired.com'), false);

    // Clear all suppressions
    await acknowledgeDomain('site1.com');
    await snoozeDomain('site2.com', 10);
    assert.equal(await isDomainSuppressed('site1.com'), true);
    assert.equal(await isDomainSuppressed('site2.com'), true);

    await clearAllSuppressions();
    assert.equal(await isDomainSuppressed('site1.com'), false);
    assert.equal(await isDomainSuppressed('site2.com'), false);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('TelemetryCollector warning presentation, acknowledge, and snooze prevents re-triggering', async () => {
  // Setup DOM mock environment
  const elements: Record<string, HTMLElement> = {};
  const createdElements: HTMLElement[] = [];

  const fakeDoc = {
    title: 'Test Phishing Site',
    readyState: 'complete',
    body: {
      appendChild: (el: HTMLElement) => {
        createdElements.push(el);
        if (el.id) elements[el.id] = el;
      },
    },
    getElementById: (id: string) => elements[id] || null,
    querySelector: (_sel: string) => null,
    createElement: (tag: string) => {
      const el = {
        tagName: tag.toUpperCase(),
        id: '',
        style: { cssText: '' },
        textContent: '',
        children: [] as any[],
        listeners: {} as Record<string, Function[]>,
        appendChild: (child: any) => {
          el.children.push(child);
          if (child.id) elements[child.id] = child;
        },
        addEventListener: (event: string, fn: Function) => {
          el.listeners[event] = el.listeners[event] || [];
          el.listeners[event].push(fn);
        },
        remove: () => {
          if (el.id) delete elements[el.id];
          const idx = createdElements.indexOf(el as any);
          if (idx !== -1) createdElements.splice(idx, 1);
        },
        setAttribute: (_k: string, _v: string) => {},
      };
      return el as unknown as HTMLElement;
    },
  };

  const sentMessages: any[] = [];
  const fakeStorage: Record<string, unknown> = {};

  const originalDoc = (globalThis as any).document;
  const originalWindow = (globalThis as any).window;
  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).document = fakeDoc;
  (globalThis as any).window = {
    location: {
      href: 'https://paypal-security-auth.fake/login',
      hostname: 'paypal-security-auth.fake',
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
  };
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: (msg: any) => {
        sentMessages.push(msg);
        return Promise.resolve();
      },
      onMessage: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    storage: {
      local: {
        get: async (keys: string[]) => {
          const res: Record<string, unknown> = {};
          keys.forEach((k) => {
            if (fakeStorage[k] !== undefined) res[k] = fakeStorage[k];
          });
          return res;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(fakeStorage, items);
        },
      },
    },
  };

  try {
    const collector = new TelemetryCollector();

    // 1. Render warning overlay
    collector.renderWarning('overlay', 'PayPal', ['Deceptive credential solicitation']);
    const overlay = fakeDoc.getElementById('phishguard-warning-overlay');
    assert.ok(overlay, 'Warning overlay should be rendered');

    const ackBtn = fakeDoc.getElementById('phishguard-btn-ack') as any;
    const snoozeBtn = fakeDoc.getElementById('phishguard-btn-snooze') as any;
    const leaveBtn = fakeDoc.getElementById('phishguard-btn-leave') as any;

    assert.ok(ackBtn, 'Overlay must include Acknowledge Risk button');
    assert.ok(snoozeBtn, 'Overlay must include Snooze button');
    assert.ok(leaveBtn, 'Overlay must include Leave Site button');

    // 2. Click Acknowledge Risk
    assert.equal(collector.isSuppressed(), false);
    ackBtn.listeners['click'][0](); // Trigger click

    // Overlay should be removed and collector marked acknowledged
    assert.equal(fakeDoc.getElementById('phishguard-warning-overlay'), null);
    assert.equal(collector.isSuppressed(), true);
    assert.ok(sentMessages.some((m) => m.type === 'ACKNOWLEDGE_DOMAIN' && m.domain === 'paypal-security-auth.fake'));

    // 3. Crucial Fix Verification: Telemetry dispatch or repeat warning DOES NOT bring back the warning!
    collector.renderWarning('overlay', 'PayPal', ['Repeat evaluation']);
    assert.equal(
      fakeDoc.getElementById('phishguard-warning-overlay'),
      null,
      'Warning overlay MUST NOT re-appear after acknowledgment'
    );

    // 4. Test Snooze behavior on a fresh collector
    const collector2 = new TelemetryCollector();
    collector2.renderWarning('banner', 'Microsoft', ['Suspicious input topology']);
    const banner = fakeDoc.getElementById('phishguard-warning-banner');
    assert.ok(banner, 'Warning banner should be rendered');

    const bannerSnoozeBtn = fakeDoc.getElementById('phishguard-banner-btn-snooze') as any;
    assert.ok(bannerSnoozeBtn, 'Banner must include Snooze button');

    // Click Snooze on banner
    bannerSnoozeBtn.listeners['click'][0]();
    assert.equal(fakeDoc.getElementById('phishguard-warning-banner'), null);
    assert.equal(collector2.isSuppressed(), true);
    assert.ok(sentMessages.some((m) => m.type === 'SNOOZE_DOMAIN' && m.domain === 'paypal-security-auth.fake'));

    // Re-render attempt while snoozed is rejected
    collector2.renderWarning('banner', 'Microsoft', ['Repeat evaluation']);
    assert.equal(
      fakeDoc.getElementById('phishguard-warning-banner'),
      null,
      'Banner MUST NOT re-appear while snoozed'
    );

    // 5. Test Toast notification rendering
    const collector3 = new TelemetryCollector();
    collector3.renderWarning('notification', 'Google', ['Behavioral anomaly']);
    const toast = fakeDoc.getElementById('phishguard-warning-toast');
    assert.ok(toast, 'Warning toast should be rendered in notification mode');

    const toastAckBtn = fakeDoc.getElementById('phishguard-toast-btn-ack') as any;
    const toastSnoozeBtn = fakeDoc.getElementById('phishguard-toast-btn-snooze') as any;
    assert.ok(toastAckBtn, 'Toast must include Acknowledge button');
    assert.ok(toastSnoozeBtn, 'Toast must include Snooze button');

    collector.destroy();
    collector2.destroy();
    collector3.destroy();
  } finally {
    (globalThis as any).document = originalDoc;
    (globalThis as any).window = originalWindow;
    (globalThis as any).chrome = originalChrome;
  }
});

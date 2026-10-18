import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const MISSING_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

const chromeMock: any = {
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: {
      addListener: (fn: any) => {
        chromeMock.runtime.messageListener = fn;
      },
    },
    sendMessage: async () => {},
    lastError: null as { message?: string } | null,
    messageListener: null as any,
  },
  tabs: {
    get: async (tabId: number) => ({ id: tabId, url: 'https://bank.example/login' }),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    sendMessage: (tabId: number, message: any, callback?: (response?: unknown) => void) => {
      chromeMock.tabs.sent.push({ tabId, message });
      const behavior = chromeMock.tabs.behaviors.get(chromeMock.tabs.sent.length) ?? {};
      if (behavior.error) {
        chromeMock.runtime.lastError = { message: behavior.error };
        callback?.(undefined);
      } else {
        chromeMock.runtime.lastError = null;
        callback?.(behavior.response);
      }
    },
    sent: [] as Array<{ tabId: number; message: any }>,
    behaviors: new Map<number, { error?: string; response?: unknown }>(),
  },
  scripting: {
    executeScript: async (details: any) => {
      chromeMock.scripting.calls.push(details);
      if (chromeMock.scripting.rejection) throw chromeMock.scripting.rejection;
      return [];
    },
    calls: [] as any[],
    rejection: null as unknown,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
    onClicked: { addListener: () => {} },
  },
  notifications: {
    create: async () => {},
    onClicked: { addListener: () => {} },
    onButtonClicked: { addListener: () => {} },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webNavigation: {
    onBeforeNavigate: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
  },
  declarativeNetRequest: {
    updateSessionRules: async () => {},
    onRuleMatchedDebug: { addListener: () => {} },
  },
  downloads: { download: async () => 1 },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

(globalThis as any).chrome = chromeMock;

await import('../src/background/service-worker.ts');
const listener = chromeMock.runtime.messageListener;
assert.ok(listener, 'service worker registers a runtime.onMessage listener');

function dispatchRequest(tabId: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: 'REQUEST_TAB_EVALUATION', tabId, forceVision: true },
      { tab: { id: tabId, url: 'https://bank.example/login' } },
      (response: any) => resolve(response)
    );
    assert.equal(keepAlive, true, 'REQUEST_TAB_EVALUATION keeps the message channel open');
    setTimeout(() => reject(new Error('no sendResponse within 2s')), 2000);
  });
}

beforeEach(() => {
  chromeMock.tabs.sent = [];
  chromeMock.tabs.behaviors.clear();
  chromeMock.scripting.calls = [];
  chromeMock.scripting.rejection = null;
  chromeMock.runtime.lastError = null;
});

test('missing receiver injects packaged dist/content.js once and retries the request', async () => {
  // The injection guard is once-per-document per tab; use a unique tab id per test.
  chromeMock.tabs.behaviors.set(1, { error: MISSING_RECEIVER });
  chromeMock.tabs.behaviors.set(2, { response: { evalResult: { result: null } } });

  const response = await dispatchRequest(71);
  assert.deepEqual(response, { success: true, response: { evalResult: { result: null } } });
  assert.equal(chromeMock.scripting.calls.length, 1);
  assert.deepEqual(chromeMock.scripting.calls[0].files, ['dist/content.js']);
  assert.equal(chromeMock.scripting.calls[0].target.tabId, 71);
  assert.equal(chromeMock.tabs.sent.length, 2);
});

test('second missing receiver in the same document does not re-inject', async () => {
  chromeMock.tabs.behaviors.set(1, { error: MISSING_RECEIVER });
  chromeMock.tabs.behaviors.set(2, { error: MISSING_RECEIVER });

  const first = await dispatchRequest(72);
  assert.deepEqual(first, { success: false, reason: 'no_collector' });
  assert.equal(chromeMock.scripting.calls.length, 1);

  // The next request retries the collector without injecting again.
  chromeMock.tabs.behaviors.set(3, { response: { evalResult: { result: null } } });
  const second = await dispatchRequest(72);
  assert.deepEqual(second, { success: true, response: { evalResult: { result: null } } });
  assert.equal(chromeMock.scripting.calls.length, 1, 'no second injection in the same document');
  assert.equal(chromeMock.tabs.sent.length, 3);
});

test('restricted tab URLs classify as restricted without injection', async () => {
  const originalGet = chromeMock.tabs.get;
  chromeMock.tabs.get = async (tabId: number) => ({ id: tabId, url: 'chrome://extensions' });
  try {
    const response = await dispatchRequest(73);
    assert.deepEqual(response, { success: false, reason: 'restricted' });
    assert.equal(chromeMock.scripting.calls.length, 0);
    assert.equal(chromeMock.tabs.sent.length, 0);
  } finally {
    chromeMock.tabs.get = originalGet;
  }
});

test('an executeScript rejection classifies as restricted', async () => {
  chromeMock.tabs.behaviors.set(1, { error: MISSING_RECEIVER });
  chromeMock.scripting.rejection = new Error('Cannot access contents of the page');

  const response = await dispatchRequest(74);
  assert.deepEqual(response, { success: false, reason: 'restricted' });
  assert.equal(chromeMock.scripting.calls.length, 1);
});

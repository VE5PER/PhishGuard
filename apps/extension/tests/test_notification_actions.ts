import test from 'node:test';
import assert from 'node:assert/strict';

test('native notification actions stay bound to the originating page and configured snooze', async () => {
  const sessionStore: Record<string, unknown> = {};
  const localStore: Record<string, unknown> = { snoozeDurationMinutes: 7 };
  const tabs = new Map<number, { id: number; url: string }>([
    [1, { id: 1, url: 'https://warned.example/login' }],
    [2, { id: 2, url: 'https://benign.example/' }],
  ]);
  const identities = new Map<number, Record<string, unknown>>([
    [1, {
      pageSessionId: 'warned-session',
      navigationGeneration: 4,
      evaluationGeneration: 9,
      url: 'https://warned.example/login',
      warningVisible: false,
      topologyScanComplete: true,
    }],
    [2, {
      pageSessionId: 'benign-session',
      navigationGeneration: 0,
      evaluationGeneration: 1,
      url: 'https://benign.example/',
      warningVisible: false,
      topologyScanComplete: true,
    }],
  ]);
  const updates: Array<{ tabId: number; url?: string }> = [];
  const created: string[] = [];
  const cleared: string[] = [];
  const buttonListeners: Array<(notificationId: string, buttonIndex: number) => void> = [];
  const closedListeners: Array<(notificationId: string) => void> = [];
  const runtime = { lastError: undefined as { message: string } | undefined };
  const chromeMock = {
    runtime: {
      ...runtime,
      getURL: (path: string) => `chrome-extension://fixture/${path}`,
      onMessage: { addListener: () => undefined },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: sessionStore[key] }),
        set: async (items: Record<string, unknown>) => Object.assign(sessionStore, items),
        remove: async (key: string) => {
          delete sessionStore[key];
        },
      },
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((key) => key in localStore).map((key) => [key, localStore[key]])),
        set: async (items: Record<string, unknown>) => Object.assign(localStore, items),
      },
    },
    tabs: {
      get: (tabId: number, callback: (tab?: { id: number; url: string }) => void) => {
        const tab = tabs.get(tabId);
        callback(tab);
      },
      sendMessage: (tabId: number, message: { type: string }, callback?: (response?: unknown) => void) => {
        if (message.type === 'GET_PAGE_IDENTITY') callback?.(identities.get(tabId));
      },
      update: async (tabId: number, update: { url?: string }) => {
        updates.push({ tabId, url: update.url });
        const tab = tabs.get(tabId);
        if (tab && update.url) tab.url = update.url;
      },
    },
    notifications: {
      create: (notificationId: string) => created.push(notificationId),
      clear: (notificationId: string) => {
        cleared.push(notificationId);
      },
      onButtonClicked: { addListener: (listener: typeof buttonListeners[number]) => buttonListeners.push(listener) },
      onClosed: { addListener: (listener: typeof closedListeners[number]) => closedListeners.push(listener) },
    },
  };
  (globalThis as unknown as { chrome: typeof chrome }).chrome = chromeMock as unknown as typeof chrome;
  const worker = await import('../src/background/service-worker.ts');
  const origin = {
    tabId: 1,
    pageSessionId: 'warned-session',
    navigationGeneration: 4,
    url: 'https://warned.example/login',
  };
  const createNotification = () => worker.triggerDesktopNotification(
    'warned.example',
    'Brand',
    ['validated evidence'],
    45,
    origin,
  );

  try {
    await createNotification();
    assert.ok(buttonListeners.length >= 1);
    assert.equal(closedListeners.length, 1);
    assert.equal(created.length, 1);
    const leaveId = created[0];
    assert.ok(Object.keys(sessionStore).some((key) => key.endsWith(leaveId)));
    await worker.handleDesktopNotificationButtonClick(leaveId, 0);
    assert.deepEqual(updates, [{ tabId: 1, url: 'about:blank' }]);
    assert.equal(tabs.get(2)?.url, 'https://benign.example/');

    tabs.set(1, { id: 1, url: origin.url });
    identities.set(1, {
      pageSessionId: origin.pageSessionId,
      navigationGeneration: origin.navigationGeneration,
      evaluationGeneration: 10,
      url: origin.url,
      warningVisible: false,
      topologyScanComplete: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await createNotification();
    const snoozeId = created[1];
    const now = Date.now();
    await worker.handleDesktopNotificationButtonClick(snoozeId, 1);
    const snoozed = localStore.snoozedDomains as Record<string, number>;
    assert.ok(snoozed['warned.example'] >= now + 45 * 60 * 1000 - 1000);
    assert.ok(snoozed['warned.example'] <= now + 45 * 60 * 1000 + 1000);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await createNotification();
    const staleId = created[2];
    tabs.set(1, { id: 1, url: 'https://warned.example/new-route' });
    identities.set(1, {
      pageSessionId: 'new-session',
      navigationGeneration: 0,
      evaluationGeneration: 1,
      url: 'https://warned.example/new-route',
      warningVisible: false,
      topologyScanComplete: true,
    });
    await worker.handleDesktopNotificationButtonClick(staleId, 0);
    assert.equal(updates.length, 1);

    tabs.set(1, { id: 1, url: origin.url });
    identities.set(1, {
      pageSessionId: origin.pageSessionId,
      navigationGeneration: origin.navigationGeneration,
      evaluationGeneration: 11,
      url: origin.url,
      warningVisible: false,
      topologyScanComplete: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await createNotification();
    const closedId = created[3];
    tabs.delete(1);
    await worker.handleDesktopNotificationButtonClick(closedId, 0);
    assert.equal(updates.length, 1);
    await worker.handleDesktopNotificationButtonClick('phishguard-block-unknown-1', 0);
    assert.equal(updates.length, 1);
    assert.equal(cleared.length, 5);
  } finally {
    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome;
  }
});

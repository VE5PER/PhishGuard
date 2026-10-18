import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSemver,
  ExtensionUpdateManager,
} from '../src/background/extension-update-manager.ts';

test('compareSemver accurately compares Semantic Versioning strings', () => {
  // Minor bumps
  assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);

  // Patch bumps
  assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.1'), -1);

  // Major bumps
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  assert.equal(compareSemver('2.1.0', '1.9.9'), 1);
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1);

  // Leading 'v' prefixes and whitespace
  assert.equal(compareSemver('v0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('  v1.0.0 ', ' 1.0.0 '), 0);
  assert.equal(compareSemver('v0.1.0', 'v0.2.0'), -1);

  // Release candidates / build metadata
  assert.equal(compareSemver('0.2.0-rc1', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.2.0-beta'), -1);
});

test('ExtensionUpdateManager detects newer backend version release', async () => {
  const originalFetch = globalThis.fetch;
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://mock-backend:8000');

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/extension/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'PhishGuard Browser Extension',
            version: '0.2.0',
            extension_id: 'abcdefghijklmnopabcdefghijklmnop',
            filename: 'phishguard-extension.zip',
            download_url: '/download/extension',
            crx_filename: 'phishguard-extension.crx',
            crx_download_url: '/download/crx',
            sha256: 'a'.repeat(64),
            crx_sha256: 'b'.repeat(64),
            size_bytes: 1048576,
            size_formatted: '1.00 MB',
            crx_size_bytes: 1050000,
            crx_size_formatted: '1.00 MB',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const status = await manager.checkForExtensionUpdate({ interactive: true });

    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestVersion, '0.2.0');
    assert.equal(status.currentVersion, '0.1.0');
    assert.equal(status.backendReachable, true);
    assert.equal(status.checkMethod, 'MANUAL_CHECK');
    assert.ok(status.releaseMeta);
    assert.equal(status.releaseMeta.crx_filename, 'phishguard-extension.crx');
    assert.equal(status.installPromptShown, true);
    assert.ok(status.statusMessage?.includes('v0.2.0'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ExtensionUpdateManager reports up to date when versions match', async () => {
  const originalFetch = globalThis.fetch;
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://mock-backend:8000');

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/extension/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'PhishGuard Browser Extension',
            version: '0.1.0',
            filename: 'phishguard-extension.zip',
            download_url: '/download/extension',
            sha256: 'a'.repeat(64),
            size_bytes: 1048576,
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const status = await manager.checkForExtensionUpdate({ interactive: false });

    assert.equal(status.updateAvailable, false);
    assert.equal(status.latestVersion, '0.1.0');
    assert.equal(status.currentVersion, '0.1.0');
    assert.equal(status.backendReachable, true);
    assert.ok(status.statusMessage?.includes('up to date'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ExtensionUpdateManager handles offline backend gracefully', async () => {
  const originalFetch = globalThis.fetch;
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://unreachable-backend:8000');

  try {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    }) as unknown as typeof fetch;

    const status = await manager.checkForExtensionUpdate();

    assert.equal(status.backendReachable, false);
    assert.equal(status.checkMethod, 'OFFLINE_CACHE');
    assert.equal(status.updateAvailable, false);
    assert.ok(status.statusMessage?.includes('unreachable'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ExtensionUpdateManager resolves correct download URL on install trigger', async () => {
  const originalFetch = globalThis.fetch;
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://mock-backend:8000');

  try {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'PhishGuard Browser Extension',
          version: '0.3.0',
          filename: 'phishguard-extension.zip',
          download_url: '/download/extension',
          crx_filename: 'phishguard-extension.crx',
          crx_download_url: '/download/crx',
          sha256: 'a'.repeat(64),
          size_bytes: 1048576,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.checkForExtensionUpdate();
    const result = await manager.installExtensionUpdate();

    assert.equal(result.success, true);
    assert.equal(result.action, 'DOWNLOAD_OPENED');
    assert.equal(result.url, 'http://mock-backend:8000/download/crx');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ExtensionUpdateManager queries available versions list for downgrade', async () => {
  const originalFetch = globalThis.fetch;
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://mock-backend:8000');

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/extension/versions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            versions: [
              { version: '0.2.0', is_latest: true, crx_download_url: '/download/version/0.2.0/crx' },
              { version: '0.1.0', is_latest: false, crx_download_url: '/download/version/0.1.0/crx' },
            ],
            latest: '0.2.0',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const list = await manager.getAvailableVersions();
    assert.equal(list.versions.length, 2);
    assert.equal(list.versions[0].version, '0.2.0');
    assert.equal(list.versions[0].is_latest, true);
    assert.equal(list.versions[1].version, '0.1.0');
    assert.equal(list.latest, '0.2.0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ExtensionUpdateManager generates specific version download url for installVersion', async () => {
  const manager = new ExtensionUpdateManager();
  manager.setBackendUrl('http://mock-backend:8000');

  const crxRes = await manager.installVersion('0.1.0', 'crx');
  assert.equal(crxRes.success, true);
  assert.equal(crxRes.url, 'http://mock-backend:8000/download/version/0.1.0/crx');

  const zipRes = await manager.installVersion('v0.2.0', 'zip');
  assert.equal(zipRes.success, true);
  assert.equal(zipRes.url, 'http://mock-backend:8000/download/version/0.2.0/zip');
});


interface MockChromeOptions {
  installType?: string;
  updateUrl?: string;
  updateCheckStatus?: string;
}

function installMockChrome(opts: MockChromeOptions) {
  const calls = { reload: 0, requestUpdateCheck: 0, tabsCreate: [] as string[], notifications: [] as unknown[] };
  const store: Record<string, unknown> = {};
  const g = globalThis as unknown as { chrome?: unknown };
  g.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.3.0', ...(opts.updateUrl ? { update_url: opts.updateUrl } : {}) }),
      reload: () => {
        calls.reload++;
      },
      requestUpdateCheck: async () => {
        calls.requestUpdateCheck++;
        return { status: opts.updateCheckStatus ?? 'no_update' };
      },
      getURL: (p: string) => p,
    },
    management: { getSelf: async () => ({ installType: opts.installType ?? 'normal' }) },
    tabs: {
      create: async ({ url }: { url: string }) => {
        calls.tabsCreate.push(url);
      },
    },
    storage: {
      local: {
        set: async (v: Record<string, unknown>) => Object.assign(store, v),
        get: async (k: string) => ({ [k]: store[k] }),
      },
    },
    notifications: {
      create: (_id: string, o: unknown) => {
        calls.notifications.push(o);
      },
    },
  };
  return calls;
}

function mockLatestFetch(version: string) {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'PhishGuard Browser Extension',
        version,
        filename: 'phishguard-extension.zip',
        download_url: '/download/extension',
        crx_download_url: '/download/crx',
        sha256: 'a'.repeat(64),
        size_bytes: 1,
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

async function withMockChrome(opts: MockChromeOptions, fn: (calls: ReturnType<typeof installMockChrome>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const g = globalThis as unknown as { chrome?: unknown };
  const originalChrome = g.chrome;
  try {
    const calls = installMockChrome(opts);
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    g.chrome = originalChrome;
  }
}

test('detectChannel picks NATIVE, MANUAL_UNPACKED and MANUAL_CRX', async () => {
  await withMockChrome({ updateUrl: 'https://e/download/updates.xml' }, async () => {
    assert.equal(await new ExtensionUpdateManager().detectChannel(), 'NATIVE');
  });
  await withMockChrome({ installType: 'development', updateUrl: 'https://e/download/updates.xml' }, async () => {
    assert.equal(await new ExtensionUpdateManager().detectChannel(), 'MANUAL_UNPACKED');
  });
  await withMockChrome({}, async () => {
    assert.equal(await new ExtensionUpdateManager().detectChannel(), 'MANUAL_CRX');
  });
});

test('NATIVE channel checks via Chrome, never opens a CRX download, and reloads when ready', async () => {
  await withMockChrome({ updateUrl: 'https://e/download/updates.xml', updateCheckStatus: 'no_update' }, async (calls) => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.1');

    const status = await manager.checkForExtensionUpdate();
    assert.equal(status.updateChannel, 'NATIVE');
    assert.equal(status.checkMethod, 'NATIVE_RUNTIME');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.nativeUpdateReady, false);
    assert.ok(status.statusMessage?.includes('Chrome will fetch'));
    assert.equal(calls.notifications.length, 0);

    const result = await manager.installExtensionUpdate();
    assert.equal(result.action, 'UPDATE_CHECK_REQUESTED');
    assert.equal(result.url, undefined);
    assert.deepEqual(calls.tabsCreate, []);
    assert.equal(calls.reload, 0);
    assert.ok(calls.requestUpdateCheck >= 2);
  });

  await withMockChrome({ updateUrl: 'https://e/download/updates.xml', updateCheckStatus: 'update_available' }, async (calls) => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.1');

    const status = await manager.checkForExtensionUpdate();
    assert.equal(status.nativeUpdateReady, true);
    assert.equal(manager.isUpdatePendingReload(), true);

    const result = await manager.installExtensionUpdate();
    assert.equal(result.action, 'RELOAD_TRIGGERED');
    assert.equal(calls.reload, 1);
    assert.deepEqual(calls.tabsCreate, []);
  });
});

test('NATIVE channel surfaces throttled update checks as a status message', async () => {
  await withMockChrome({ updateUrl: 'https://e/download/updates.xml', updateCheckStatus: 'throttled' }, async () => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.0');
    const status = await manager.checkForExtensionUpdate();
    assert.ok(status.statusMessage?.includes('throttled'));
    const result = await manager.installExtensionUpdate();
    assert.equal(result.action, 'UPDATE_CHECK_REQUESTED');
    assert.ok(result.message?.includes('throttled'));
  });
});

test('MANUAL_CRX and MANUAL_UNPACKED channels open the right download URL', async () => {
  await withMockChrome({}, async (calls) => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.1');
    await manager.checkForExtensionUpdate();
    const result = await manager.installExtensionUpdate();
    assert.equal(result.action, 'DOWNLOAD_OPENED');
    assert.equal(result.url, 'http://mock-backend:8000/download/crx');
    assert.deepEqual(calls.tabsCreate, ['http://mock-backend:8000/download/crx']);
    assert.equal(calls.requestUpdateCheck, 0);
  });

  await withMockChrome({ installType: 'development' }, async (calls) => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.1');
    await manager.checkForExtensionUpdate();
    const result = await manager.installExtensionUpdate();
    assert.equal(result.action, 'DOWNLOAD_OPENED');
    assert.equal(result.url, 'http://mock-backend:8000/download/extension');
    assert.ok(result.message?.includes('Unzip'));
    assert.deepEqual(calls.tabsCreate, ['http://mock-backend:8000/download/extension']);
  });
});

test('ExtensionUpdateManager notifies only once per available version', async () => {
  await withMockChrome({}, async (calls) => {
    const manager = new ExtensionUpdateManager();
    manager.setBackendUrl('http://mock-backend:8000');
    mockLatestFetch('0.3.1');

    const first = await manager.checkForExtensionUpdate({ interactive: false });
    assert.equal(first.installPromptShown, true);
    assert.equal(calls.notifications.length, 1);

    await manager.checkForExtensionUpdate({ interactive: false });
    assert.equal(calls.notifications.length, 1);

    await manager.checkForExtensionUpdate({ interactive: true });
    assert.equal(calls.notifications.length, 2);
  });
});

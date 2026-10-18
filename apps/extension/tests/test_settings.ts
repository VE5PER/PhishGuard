import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEndpointUrl, pingBackend, DEFAULT_BACKEND_URL } from '../options/options.ts';

test('explainability UI is available in the popup, not settings', () => {
  const optionsHtml = readFileSync(new URL('../options/options.html', import.meta.url), 'utf8');
  const popupHtml = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');

  for (const marker of ['btn-toggle-explain', 'signals-explain-drawer', 'cue-interaction', 'cue-pill']) {
    assert.ok(!optionsHtml.includes(marker), `settings HTML should not contain ${marker}`);
  }

  assert.ok(popupHtml.includes('btn-toggle-explain'));
  assert.ok(popupHtml.includes('signals-explain-drawer'));
});

test('settings diagnostics omit the round-trip latency row but keep the connection test', () => {
  const optionsHtml = readFileSync(new URL('../options/options.html', import.meta.url), 'utf8');
  const optionsTs = readFileSync(new URL('../options/options.ts', import.meta.url), 'utf8');

  assert.ok(!optionsHtml.includes('Round-trip Latency'), 'settings HTML should not show a latency row');
  assert.ok(!optionsHtml.includes('diag-latency'), 'settings HTML should not contain diag-latency');
  assert.ok(!optionsTs.includes('diagLatency'), 'settings controller should not bind diagLatency');

  for (const marker of ['diag-box', 'diag-status', 'diag-service', 'diag-teacher', 'diag-model', 'backend-url', 'btn-test']) {
    assert.ok(optionsHtml.includes(marker), `settings HTML should keep ${marker}`);
  }
  assert.ok(optionsTs.includes('runConnectionTest'));
  assert.ok(optionsTs.includes('pingBackend'));
});

test('normalizeEndpointUrl normalizes various dev and production URL patterns', () => {
  // Empty or whitespace returns default
  assert.equal(normalizeEndpointUrl(''), DEFAULT_BACKEND_URL);
  assert.equal(normalizeEndpointUrl('   '), DEFAULT_BACKEND_URL);

  // Host without protocol gets http:// prepended
  assert.equal(normalizeEndpointUrl('localhost:8000'), 'http://localhost:8000');
  assert.equal(normalizeEndpointUrl('127.0.0.1:8000'), 'http://127.0.0.1:8000');
  assert.equal(normalizeEndpointUrl('host.docker.internal:8000'), 'http://host.docker.internal:8000');

  // Trailing slashes are stripped
  assert.equal(normalizeEndpointUrl('http://localhost:8000/'), 'http://localhost:8000');
  assert.equal(normalizeEndpointUrl('http://localhost:8000///'), 'http://localhost:8000');
  assert.equal(normalizeEndpointUrl('https://api.phishguard.local/'), 'https://api.phishguard.local');

  // HTTPS is preserved
  assert.equal(normalizeEndpointUrl('https://remote.server.org:8443'), 'https://remote.server.org:8443');
});

test('pingBackend handles successful backend health and model discovery', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'healthy', service: 'phishguard-backend', version: '0.1.0' }),
        } as unknown as Response;
      }
      if (url.endsWith('/v1/models/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '1.2.0', name: 'student-int8-quantized' }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await pingBackend('http://localhost:8000');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'Connected (Healthy)');
    assert.equal(result.service, 'phishguard-backend');
    assert.equal(result.version, '0.1.0');
    assert.equal(result.latestModel, 'v1.2.0 (student-int8-quantized)');
    assert.ok(typeof result.latencyMs === 'number');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pingBackend handles server error responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await pingBackend('http://localhost:8000');
    assert.equal(result.ok, false);
    assert.ok(result.status.includes('503'));
    assert.ok(result.error?.includes('503'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pingBackend handles network unreachable errors gracefully', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    }) as unknown as typeof fetch;

    const result = await pingBackend('http://localhost:8000');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'Connection Failed');
    assert.ok(result.error?.includes('ECONNREFUSED'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

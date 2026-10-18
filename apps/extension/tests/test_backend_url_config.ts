import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackendUrl, DEFAULT_BACKEND_URL } from '../src/config.ts';
import { ModelSyncManager } from '../src/background/model-sync-manager.ts';
import { ExtensionUpdateManager } from '../src/background/extension-update-manager.ts';
import { normalizeEndpointUrl } from '../options/options.ts';

test('resolveBackendUrl normalizes and strips trailing slashes from BACKEND_URL', () => {
  const originalEnv = process.env.BACKEND_URL;
  try {
    process.env.BACKEND_URL = 'https://phishguard-gateway-dev-1.example.com///';
    assert.equal(resolveBackendUrl(), 'https://phishguard-gateway-dev-1.example.com');

    process.env.BACKEND_URL = 'http://localhost:8010/';
    assert.equal(resolveBackendUrl(), 'http://localhost:8010');
  } finally {
    if (originalEnv !== undefined) {
      process.env.BACKEND_URL = originalEnv;
    } else {
      delete process.env.BACKEND_URL;
    }
  }
});

test('resolveBackendUrl falls back to GATEWAY_DOMAIN and automatically prefixes https or http', () => {
  const origBackend = process.env.BACKEND_URL;
  const origDomain = process.env.GATEWAY_DOMAIN;
  delete process.env.BACKEND_URL;

  try {
    process.env.GATEWAY_DOMAIN = 'phishguard-gateway-dev-1.example.com';
    assert.equal(resolveBackendUrl(), 'https://phishguard-gateway-dev-1.example.com');

    process.env.GATEWAY_DOMAIN = 'localhost:8010';
    assert.equal(resolveBackendUrl(), 'http://localhost:8010');

    // BACKEND_URL takes precedence when both are set
    process.env.BACKEND_URL = 'https://custom-override.example.com';
    assert.equal(resolveBackendUrl(), 'https://custom-override.example.com');
  } finally {
    if (origBackend !== undefined) process.env.BACKEND_URL = origBackend;
    else delete process.env.BACKEND_URL;
    if (origDomain !== undefined) process.env.GATEWAY_DOMAIN = origDomain;
    else delete process.env.GATEWAY_DOMAIN;
  }
});

test('ModelSyncManager defaults to DEFAULT_BACKEND_URL when no constructor argument is provided', () => {
  const manager = new ModelSyncManager();
  assert.equal(manager.getBackendUrl(), DEFAULT_BACKEND_URL);
});

test('ExtensionUpdateManager initializes with DEFAULT_BACKEND_URL', () => {
  const manager = new ExtensionUpdateManager();
  assert.equal(manager.getBackendUrl(), DEFAULT_BACKEND_URL);
});

test('normalizeEndpointUrl returns DEFAULT_BACKEND_URL on empty input', () => {
  assert.equal(normalizeEndpointUrl(''), DEFAULT_BACKEND_URL);
  assert.equal(normalizeEndpointUrl('   '), DEFAULT_BACKEND_URL);
});

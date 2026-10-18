import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSyncStatus } from '@phishguard/types';
import { presentModelRuntime } from '../popup/model-presentation.ts';

function status(syncState: ModelSyncStatus['syncState'], backendReachable: boolean): ModelSyncStatus {
  return {
    currentVersion: '1.5.0',
    latestAvailableVersion: '2.0.0',
    isLatest: false,
    lastSyncAttempt: new Date().toISOString(),
    syncState,
    backendReachable,
    modelSource: 'LOCAL_BUNDLED',
    activeMetadata: null,
  };
}

test('model runtime presentation reports loading and unavailable independently of cached sync metadata', () => {
  const cachedSynced = status('ONLINE_SYNCED', true);
  assert.equal(presentModelRuntime('loading', cachedSynced).label, 'LOADING');
  assert.equal(presentModelRuntime('unavailable', cachedSynced).label, 'NO MODEL');
});

test('a ready model stays ONLINE across backend and synchronization states', () => {
  const cases: Array<[ModelSyncStatus['syncState'], boolean]> = [
    ['OFFLINE_FALLBACK', false],
    ['SYNC_ERROR', false],
    ['ONLINE_SYNCED', true],
    ['UPDATING', true],
    ['UPDATING', false],
    ['SYNC_ERROR', true],
    ['ONLINE_UPDATE_AVAILABLE', true],
  ];
  for (const [syncState, backendReachable] of cases) {
    const presentation = presentModelRuntime('ready', status(syncState, backendReachable));
    assert.equal(presentation.label, 'ONLINE', `${syncState}, backendReachable=${backendReachable}`);
    assert.equal(presentation.tone, 'online');
  }
  assert.match(presentModelRuntime('ready', status('UPDATING', false)).title, /synchronization is in progress/);
  assert.match(presentModelRuntime('ready', status('ONLINE_SYNCED', false)).title, /backend is currently offline/);
});

test('a ready model with no sync record remains ONLINE', () => {
  const presentation = presentModelRuntime('ready');
  assert.equal(presentation.label, 'ONLINE');
  assert.match(presentation.title, /backend synchronization status is unknown/);
});

import type { ModelSyncStatus } from '@phishguard/types';
import type { LocalRuntimeState } from '../src/background/types.js';

export type ModelPresentationLabel = 'LOADING' | 'NO MODEL' | 'ONLINE';
export type ModelPresentationTone = 'syncing' | 'offline' | 'online';

export interface ModelPresentation {
  label: ModelPresentationLabel;
  tone: ModelPresentationTone;
  title: string;
}

export function presentModelRuntime(
  runtimeState: LocalRuntimeState,
  status?: ModelSyncStatus | null
): ModelPresentation {
  if (runtimeState === 'loading') {
    return {
      label: 'LOADING',
      tone: 'syncing',
      title: 'Waiting for local model initialization',
    };
  }
  if (runtimeState === 'unavailable') {
    return {
      label: 'NO MODEL',
      tone: 'offline',
      title: 'Local initialization completed without a ready model',
    };
  }
  if (!status) {
    return {
      label: 'ONLINE',
      tone: 'online',
      title: 'On-device model is ready; backend synchronization status is unknown',
    };
  }
  switch (status.syncState) {
    case 'ONLINE_SYNCED':
      return {
        label: 'ONLINE',
        tone: 'online',
        title: status.backendReachable
          ? 'On-device model is ready and synchronized'
          : 'On-device model is ready; backend is currently offline',
      };
    case 'ONLINE_UPDATE_AVAILABLE':
      return {
        label: 'ONLINE',
        tone: 'online',
        title: 'On-device model is ready; an update is available',
      };
    case 'UPDATING':
      return {
        label: 'ONLINE',
        tone: 'online',
        title: status.backendReachable
          ? 'On-device model is ready; synchronization is in progress'
          : 'On-device model is ready; synchronization is in progress while the backend is unavailable',
      };
    case 'SYNC_ERROR':
      return {
        label: 'ONLINE',
        tone: 'online',
        title: 'On-device model is ready; the last backend synchronization failed',
      };
    default:
      return {
        label: 'ONLINE',
        tone: 'online',
        title: status.backendReachable
          ? 'On-device model is ready; backend synchronization status is unknown'
          : 'On-device model is ready; backend synchronization is unavailable',
      };
  }
}

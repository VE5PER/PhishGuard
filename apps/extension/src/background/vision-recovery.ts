import type { VisionCaptureState, VisionUnavailableReason } from './types.js';

export const VISION_RECOVERY_DELAYS_MS = [500, 1500] as const;

export interface VisionRecoveryPresentation {
  captureState: VisionCaptureState;
  detail: string;
}

export function presentVisionRecovery(
  reason: VisionUnavailableReason | null | undefined,
  hasValidFrame: boolean,
  recoveryAttempt: number
): VisionRecoveryPresentation {
  if (hasValidFrame) {
    return { captureState: 'captured', detail: 'Visual frame captured' };
  }
  if (reason === 'warning_visible_no_fresh_frame') {
    return {
      captureState: 'suppressed',
      detail: 'Visual capture suppressed while the warning is visible; no fresh pre-warning frame is available',
    };
  }
  if (reason === 'missing_api') {
    return {
      captureState: 'restricted',
      detail: 'Visual capture API is unavailable; page analysis continued',
    };
  }
  if (reason === 'restricted_url') {
    return {
      captureState: 'restricted',
      detail: 'Visual capture is not permitted for this page; page analysis continued',
    };
  }
  if (reason === 'inactive_tab') {
    return {
      captureState: 'pending',
      detail: 'Visual capture is pending until this tab is active',
    };
  }
  if (reason === 'unfocused_window') {
    return {
      captureState: 'pending',
      detail: 'Visual capture is pending until this window is restored',
    };
  }
  if (reason === 'page_changed') {
    return {
      captureState: 'pending',
      detail: 'The page changed during capture; a fresh page scan is pending',
    };
  }
  if (
    reason === 'model_changed' ||
    reason === 'capture_api_failure' ||
    reason === 'decode_canvas_failure' ||
    reason === 'rate_limited'
  ) {
    const attempt = Number.isInteger(recoveryAttempt)
      ? Math.min(VISION_RECOVERY_DELAYS_MS.length, Math.max(0, recoveryAttempt))
      : 0;
    const failureDetail = reason === 'model_changed'
      ? 'The active model changed during visual capture'
      : reason === 'capture_api_failure'
        ? 'Visual capture API failed'
        : reason === 'decode_canvas_failure'
          ? 'Visual frame decoding or canvas processing failed'
          : 'Visual capture was rate limited; no fresh frame is available';
    if (attempt < VISION_RECOVERY_DELAYS_MS.length) {
      const nextAttempt = attempt + 1;
      return {
        captureState: 'pending',
        detail: `${failureDetail}; retrying visual capture ${nextAttempt} of ${VISION_RECOVERY_DELAYS_MS.length}`,
      };
    }
    return {
      captureState: 'failed',
      detail: `${failureDetail}; page analysis continued`,
    };
  }
  return {
    captureState: 'failed',
    detail: 'Visual capture failed; page analysis continued',
  };
}

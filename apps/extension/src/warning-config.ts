/**
 * PhishGuard Warning & Alert Presentation Configuration
 *
 * Provides smart decision routing and configuration models for threat warnings:
 * - 'smart': Smart Adaptive (modal overlay on credential theft / critical risk >=0.90, banner for anomalies)
 * - 'overlay': Full-screen modal overlay blocking interaction
 * - 'banner': Persistent header banner at top of viewport
 * - 'notification': In-page notification toast & desktop system notification
 */

import type { WarningPresentationType } from '@phishguard/types';

export interface WarningDecisionContext {
  hasCredentialField?: boolean;
  riskScore?: number;
  reasons?: string[];
}

export type ConcreteWarningType = 'overlay' | 'banner' | 'notification';

/**
 * Decides smartly on the warning presentation type:
 * - When explicit ('overlay', 'banner', 'notification'), honors user preference.
 * - When 'smart':
 *   - Critical risk (>= 0.90) OR credential field present -> 'overlay'
 *     (protecting against credential theft/phishing requires an intrusive blocker).
 *   - Anomaly without credentials (0.85 - 0.90) -> 'banner'
 *     (prominent top alert without completely breaking harmless browsing).
 *   - Other -> 'notification' (desktop alert & floating toast).
 */
export function decideSmartWarningType(
  configuredType: WarningPresentationType = 'smart',
  context: WarningDecisionContext = {}
): ConcreteWarningType {
  if (configuredType === 'overlay' || configuredType === 'banner' || configuredType === 'notification') {
    return configuredType;
  }

  // 1. Password input present or critical risk probability (>= 0.90) requires full-screen blocking
  if (context.hasCredentialField || (context.riskScore !== undefined && context.riskScore >= 0.90)) {
    return 'overlay';
  }

  // 2. Behavioral anomaly without password solicitation (0.85 - 0.90) uses sticky top banner
  if (context.riskScore !== undefined && context.riskScore >= 0.85) {
    return 'banner';
  }

  // 3. Fallback to notification toast
  return 'notification';
}

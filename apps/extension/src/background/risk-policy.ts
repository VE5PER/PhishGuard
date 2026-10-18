import type { TriStateAction } from '@phishguard/types';
import type { PageEvidence } from './page-context.js';

export const RISK_POLICY_VERSION = 'evidence-v2';

export function evaluateEvidenceRisk(page: PageEvidence): { score: number; reasons: string[]; ruleIds: string[] } {
  let score = 0.05;
  const reasons: string[] = [];
  const ruleIds: string[] = [];
  const add = (value: number, id: string, reason: string): void => {
    score = Math.max(score, value);
    ruleIds.push(id);
    reasons.push(reason);
  };
  if (!page.available) return { score, reasons: ['Page context unavailable'], ruleIds };
  const traps = page.credentialTraps + page.submitTraps + page.otherTraps;
  if (traps) add(0.40, 'intercepting_overlay', 'A persistent transparent overlay intercepts an interactive control');
  if (page.credentialTraps > 0 && page.credentialTraps + page.submitTraps >= 2) {
    add(0.90, 'credential_and_submit_interception', 'Distinct transparent traps intercept credential and submission controls');
  }
  if (page.credentialTraps > 0 && page.observedCredentialFrame) {
    add(0.90, 'corroborated_credential_interception', 'Credential interception is corroborated by an observed foreign-frame credential interaction');
  }
  if (page.context[0]) {
    add(page.context[3] ? 0.90 : 0.40, 'deceptive_authority', 'The URL contains an authority userinfo separator');
  }
  if (page.deceptiveHost && page.context[3]) {
    add(0.65, 'deceptive_brand_login_host', 'A brand-bearing authentication hostname is not an authorized host for that brand');
  }
  return { score, reasons, ruleIds };
}

export function composeRisk(modelScore: number | null, evidenceScore: number): { score: number; action: TriStateAction } {
  const validModel = modelScore !== null && Number.isFinite(modelScore) && modelScore >= 0 && modelScore <= 1
    ? modelScore : 0;
  const score = Math.round(Math.max(validModel, evidenceScore) * 1_000_000) / 1_000_000;
  return { score, action: score > 0.85 ? 'BLOCK' : score >= 0.15 ? 'AMBIGUOUS' : 'SAFE' };
}

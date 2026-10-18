export type AssessmentLabel =
  | 'CHECKING'
  | 'NOT ASSESSED'
  | 'LIMITED'
  | 'SAFE'
  | 'AMBIGUOUS'
  | 'BLOCKED';

export type AssessmentTone = 'neutral' | 'safe' | 'warning' | 'block';

export interface AssessmentInput {
  action: 'SAFE' | 'AMBIGUOUS' | 'BLOCK';
  riskScore: number;
  modelStatus: 'available' | 'unavailable';
  modelContract?: 'legacy' | 'student-v2' | 'none';
  pageContextAvailable: boolean;
  topologyScanComplete: boolean;
  visualAvailable?: boolean;
}

export interface AssessmentPresentation {
  label: AssessmentLabel;
  tone: AssessmentTone;
  scoreText: string;
  scorePercent: number | null;
  explanation: string;
}

function withoutAssessment(label: 'CHECKING' | 'NOT ASSESSED'): AssessmentPresentation {
  return {
    label,
    tone: 'neutral',
    scoreText: '--',
    scorePercent: null,
    explanation: label === 'CHECKING'
      ? 'Checking the current page on-device.'
      : 'This page has not been assessed.',
  };
}

export function presentAssessment(
  input: AssessmentInput | null | undefined,
  pending = false
): AssessmentPresentation {
  if (!input) return withoutAssessment(pending ? 'CHECKING' : 'NOT ASSESSED');
  if (!Number.isFinite(input.riskScore) || input.riskScore < 0 || input.riskScore > 1) {
    return withoutAssessment('NOT ASSESSED');
  }

  const scorePercent = Math.round(input.riskScore * 100);
  const scoreText = `${scorePercent}%`;
  if (input.action === 'BLOCK' || input.riskScore > 0.85) {
    return {
      label: 'BLOCKED',
      tone: 'block',
      scoreText,
      scorePercent,
      explanation: 'On-device evidence routed this page to BLOCK.',
    };
  }
  if (input.action === 'AMBIGUOUS' || input.riskScore >= 0.15) {
    return {
      label: 'AMBIGUOUS',
      tone: 'warning',
      scoreText,
      scorePercent,
      explanation: 'On-device evidence routed this page to AMBIGUOUS.',
    };
  }
  if (input.modelStatus !== 'available') {
    return {
      label: 'LIMITED',
      tone: 'neutral',
      scoreText,
      scorePercent,
      explanation: 'The on-device model is unavailable; this evidence-only result is partial.',
    };
  }
  if (!input.pageContextAvailable) {
    return {
      label: 'LIMITED',
      tone: 'neutral',
      scoreText,
      scorePercent,
      explanation: 'Page context is unavailable; this result is partial.',
    };
  }
  if (!input.topologyScanComplete) {
    return {
      label: 'LIMITED',
      tone: 'neutral',
      scoreText,
      scorePercent,
      explanation: 'The topology scan is incomplete; this result is partial.',
    };
  }
  return {
    label: 'SAFE',
    tone: 'safe',
    scoreText,
    scorePercent,
    explanation: 'The available on-device model completed this page assessment.',
  };
}

export const COVERAGE_HOLD_MS = 5000;

export interface CoverageHoldState {
  pageKey: string;
  safeAt: number;
}

/**
 * Short SAFE hold for topology-only LIMITED flicker: while a page whose last
 * complete scan was SAFE re-scans newly added elements, the last verdict
 * stays visible for up to COVERAGE_HOLD_MS. Higher-risk verdicts always
 * render immediately and clear the hold.
 */
export function holdSafeDuringRescan(
  input: AssessmentInput,
  pageKey: string,
  evaluatedAtMs: number,
  hold: CoverageHoldState | null
): { presentation: AssessmentPresentation; hold: CoverageHoldState | null } {
  const presentation = presentAssessment(input);
  if (presentation.label === 'SAFE') {
    return Number.isFinite(evaluatedAtMs)
      ? { presentation, hold: { pageKey, safeAt: evaluatedAtMs } }
      : { presentation, hold };
  }
  if (
    presentation.label === 'LIMITED' &&
    input.modelStatus === 'available' &&
    input.pageContextAvailable &&
    input.topologyScanComplete === false &&
    hold !== null &&
    hold.pageKey === pageKey &&
    Number.isFinite(evaluatedAtMs) &&
    evaluatedAtMs - hold.safeAt >= 0 &&
    evaluatedAtMs - hold.safeAt <= COVERAGE_HOLD_MS
  ) {
    return {
      presentation: {
        label: 'SAFE',
        tone: 'safe',
        scoreText: presentation.scoreText,
        scorePercent: presentation.scorePercent,
        explanation:
          'Re-scanning newly added page elements; the last complete scan found no risk.',
      },
      hold,
    };
  }
  if (presentation.label === 'AMBIGUOUS' || presentation.label === 'BLOCKED') {
    return { presentation, hold: null };
  }
  return { presentation, hold };
}

export type FetchAnalysisDecision = 'current' | 'previous' | 'pending' | 'empty';

/**
 * How to render a GET_TAB_ANALYSIS response. A snapshot reported with
 * current: false is display-only (the last completed same-page analysis,
 * kept visible while a refresh runs — never as a current verdict). With no
 * snapshot, a pending evaluation keeps the updating view; otherwise there is
 * no assessment to show.
 */
export function decideFetchAnalysisPresentation(
  hasSnapshot: boolean,
  current: boolean | undefined,
  analysisUpdating: boolean
): FetchAnalysisDecision {
  if (hasSnapshot) return current === false ? 'previous' : 'current';
  return analysisUpdating ? 'pending' : 'empty';
}

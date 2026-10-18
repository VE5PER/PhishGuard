import { z } from 'zod';
import { TriStateActionSchema } from '@phishguard/types';

const FiniteRiskSchema = z.number().finite().min(0).max(1);

export const VisionUnavailableReasonSchema = z.enum([
  'missing_api',
  'inactive_tab',
  'unfocused_window',
  'restricted_url',
  'page_changed',
  'model_changed',
  'capture_api_failure',
  'decode_canvas_failure',
  'rate_limited',
  'warning_visible_no_fresh_frame',
]);
export type VisionUnavailableReason = z.infer<typeof VisionUnavailableReasonSchema>;
export const VisionCaptureStateSchema = z.enum([
  'captured',
  'pending',
  'failed',
  'restricted',
  'suppressed',
]);
export type VisionCaptureState = z.infer<typeof VisionCaptureStateSchema>;
export type LocalRuntimeState = 'loading' | 'ready' | 'unavailable';

export const ModalityBreakdownSchema = z.object({
  interaction: z.object({
    score: z.null(),
    status: z.enum(['ok', 'skipped']),
    detail: z.string(),
    samples: z.number().int().nonnegative(),
    explainability: z.object({
      available: z.boolean(),
      validPointCount: z.number().int().nonnegative(),
      durationMs: z.number().finite().nonnegative(),
      invalidReason: z.string().nullable(),
    }).strict(),
  }).strict(),
  page: z.object({
    score: FiniteRiskSchema,
    status: z.enum(['ok', 'flag', 'skipped']),
    detail: z.string(),
    anomalies: z.number().int().nonnegative(),
    explainability: z.object({
      ruleIds: z.array(z.string()),
      reasons: z.array(z.string()),
    }).strict(),
  }).strict(),
  vision: z.object({
    score: z.null(),
    status: z.enum(['ok', 'flag', 'skipped']),
    detail: z.string(),
    explainability: z.object({
      available: z.boolean(),
      captureReason: VisionUnavailableReasonSchema.nullable().optional(),
      captureState: VisionCaptureStateSchema.optional(),
      brandLogoMismatch: z.array(z.string()).optional(),
      brandLogoReason: z.string().nullable().optional(),
    }).strict(),
  }).strict(),
  fused: z.object({
    score: FiniteRiskSchema,
    modelScore: FiniteRiskSchema.nullable(),
    evidenceScore: FiniteRiskSchema,
    modelStatus: z.enum(['available', 'unavailable']),
    modelContract: z.enum(['legacy', 'student-v2', 'none']),
    reasons: z.array(z.string()),
    ruleIds: z.array(z.string()),
    modelVersion: z.string().nullable(),
    modelHash: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable(),
    inputContractIdentifier: z.string().nullable(),
    coverage: z.object({
      trajectoryAvailable: z.boolean(),
      validPointCount: z.number().int().nonnegative(),
      durationMs: z.number().finite().nonnegative(),
      visualAvailable: z.boolean(),
      pageContextAvailable: z.boolean(),
      topologyScanComplete: z.boolean(),
    }).strict(),
  }).strict(),
}).strict();

export type ModalityBreakdown = z.infer<typeof ModalityBreakdownSchema>;

export const TabAnalysisRecordSchema = z.object({
  telemetryId: z.string().uuid(),
  url: z.string().url(),
  domain: z.string().min(1),
  pageSessionId: z.string().min(1),
  navigationGeneration: z.number().int().nonnegative(),
  evaluationGeneration: z.number().int().positive(),
  warningVisible: z.boolean(),
  topologyScanComplete: z.boolean(),
  riskScore: FiniteRiskSchema,
  action: TriStateActionSchema,
  evaluatedAt: z.string().datetime(),
  modelVersion: z.string().min(1),
  pointerSamples: z.number().int().nonnegative(),
  keystrokeSamples: z.number().int().nonnegative(),
  domAnomalies: z.number().int().nonnegative(),
  signals: ModalityBreakdownSchema,
  canEscalate: z.boolean(),
  tabId: z.number().int().nonnegative(),
}).strict();

export type TabAnalysisRecord = z.infer<typeof TabAnalysisRecordSchema>;

import { z } from 'zod';
import {
  PointerEventPointSchema,
  DOMInteractionEventSchema,
  KeystrokeDynamicsSchema,
} from './telemetry.js';

const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const TriStateActionSchema = z.enum(['SAFE', 'AMBIGUOUS', 'BLOCK']);
export type TriStateAction = z.infer<typeof TriStateActionSchema>;

export const ClientInferenceResultSchema = z.object({
  clientRiskScore: z.number().finite().min(0).max(1).describe('Fused operational risk score between 0 and 1'),
  routeAction: TriStateActionSchema.describe('Tri-state decision (<0.15 SAFE, >0.85 BLOCK, 0.15-0.85 AMBIGUOUS)'),
  inferenceLatencyMs: z.number().finite().nonnegative(),
  evaluatedAt: z.string().datetime(),
  modelVersion: z.string().min(1),
}).strict();
export type ClientInferenceResult = z.infer<typeof ClientInferenceResultSchema>;

export const EscalationPayloadSchema = z.object({
  telemetryId: z.string().uuid(),
  url: z.string().url(),
  domain: z.string().min(1),
  clientRiskScore: z.number().finite().min(0).max(1),
  hasCredentialField: z.boolean().default(false),
  clientModelVersion: z.string().nullable().optional(),
  clientModelSha256: Sha256Schema.nullable().optional(),
  clientInputContract: z.string().nullable().optional(),
  screenshotBase64: z
    .string()
    .max(2_100_000)
    .regex(/^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .optional(),
  mouseTrajectorySeries: z.array(PointerEventPointSchema).default([]),
  domElementsSummary: z.array(DOMInteractionEventSchema).default([]),
  keystrokesSummary: z.array(KeystrokeDynamicsSchema).default([]),
  clientTimestamp: z.string().datetime(),
}).strict();
export type EscalationPayload = z.input<typeof EscalationPayloadSchema>;

export const CloudActionOverrideSchema = z.enum(['ALLOW', 'BLOCK', 'WARN']);
export type CloudActionOverride = z.infer<typeof CloudActionOverrideSchema>;

export const ScreenAnalysisSchema = z.object({
  screenRiskScore: z.number().finite().min(0).max(1),
  detectedBrand: z.string().max(64).nullable().optional(),
  credentialFormVisible: z.boolean(),
  urgencyCues: z.array(z.string().max(120)).max(6).default([]),
  onScreenUrlMismatch: z.boolean(),
  reasons: z.array(z.string().max(300)).max(6).default([]),
}).strict();
export type ScreenAnalysis = z.infer<typeof ScreenAnalysisSchema>;

export const CloudInferenceVerdictSchema = z.object({
  analysisId: z.string().uuid(),
  telemetryId: z.string().uuid(),
  isPhishing: z.boolean(),
  targetBrand: z.string().nullable().optional(),
  confidence: z.number().finite().min(0).max(1),
  actionOverride: CloudActionOverrideSchema,
  explanationReasons: z.array(z.string()),
  teacherModelVersion: z.string(),
  evaluatedAt: z.string().datetime(),
  riskScore: z.number().finite().min(0).max(1).nullable().optional(),
  screenAnalysis: ScreenAnalysisSchema.nullable().optional(),
}).strict();
export type CloudInferenceVerdict = z.infer<typeof CloudInferenceVerdictSchema>;

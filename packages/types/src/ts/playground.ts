import { z } from 'zod';
import { EscalationPayloadSchema, CloudInferenceVerdictSchema } from './inference.js';
import { PointerEventPointSchema, KeystrokeDynamicsSchema, DOMInteractionEventSchema } from './telemetry.js';

const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const PlaygroundScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  tagline: z.string(),
  payload: EscalationPayloadSchema,
}).strict();
export type PlaygroundScenario = z.infer<typeof PlaygroundScenarioSchema>;

export const PlaygroundScenarioListSchema = z.object({
  scenarios: z.array(PlaygroundScenarioSchema),
  geminiConfigured: z.boolean(),
  geminiModel: z.string().nullable(),
}).strict();
export type PlaygroundScenarioList = z.infer<typeof PlaygroundScenarioListSchema>;

export const PlaygroundInteractionSchema = z.object({
  mouseTrajectorySeries: z.array(PointerEventPointSchema).min(1).max(128),
  keystrokesSummary: z.array(KeystrokeDynamicsSchema).max(128).default([]),
  observedDomEvents: z
    .array(DOMInteractionEventSchema.refine((event) => event.evidenceSource === 'observed_interaction', {
      message: 'evidenceSource must be observed_interaction',
    }))
    .max(32)
    .default([]),
}).strict();
export type PlaygroundInteraction = z.input<typeof PlaygroundInteractionSchema>;

export const PlaygroundRunRequestSchema = z.object({
  clientRiskScore: z.number().finite().min(0).max(1),
  clientModelVersion: z.string().nullable().optional(),
  clientModelSha256: Sha256Schema.nullable().optional(),
  clientInputContract: z.string().nullable().optional(),
  interaction: PlaygroundInteractionSchema.nullable().optional(),
}).strict();
export type PlaygroundRunRequest = z.input<typeof PlaygroundRunRequestSchema>;

export const TeacherToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.unknown()),
  result: z.record(z.unknown()),
}).strict();
export type TeacherToolCall = z.infer<typeof TeacherToolCallSchema>;

export const TeacherTraceStatusSchema = z.enum(['ok', 'fallback', 'unconfigured', 'circuit_open', 'budget_exhausted']);
export type TeacherTraceStatus = z.infer<typeof TeacherTraceStatusSchema>;

export const TeacherTraceSchema = z.object({
  status: TeacherTraceStatusSchema,
  model: z.string().nullable(),
  toolCalls: z.array(TeacherToolCallSchema),
  latencyMs: z.number().finite().nonnegative(),
  cached: z.boolean(),
  fallbackReason: z.string().nullable(),
}).strict();
export type TeacherTrace = z.infer<typeof TeacherTraceSchema>;

export const PlaygroundTeacherResultSchema = z.object({
  verdict: CloudInferenceVerdictSchema,
  latencyMs: z.number().finite().nonnegative(),
  cached: z.boolean(),
}).strict();
export type PlaygroundTeacherResult = z.infer<typeof PlaygroundTeacherResultSchema>;

export const PlaygroundGeminiResultSchema = z.object({
  verdict: CloudInferenceVerdictSchema,
  latencyMs: z.number().finite().nonnegative(),
  cached: z.boolean(),
  trace: TeacherTraceSchema,
}).strict();
export type PlaygroundGeminiResult = z.infer<typeof PlaygroundGeminiResultSchema>;

export const PlaygroundRunResponseSchema = z.object({
  payload: EscalationPayloadSchema,
  evidence: PlaygroundTeacherResultSchema,
  gemini: PlaygroundGeminiResultSchema,
}).strict();
export type PlaygroundRunResponse = z.infer<typeof PlaygroundRunResponseSchema>;

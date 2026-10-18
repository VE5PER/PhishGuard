import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const ModelInputTensorSchema = z.object({
  name: z.string(),
  dtype: z.literal('float32'),
  shape: z.array(z.number().int().positive()).min(1),
}).strict();
export type ModelInputTensor = z.infer<typeof ModelInputTensorSchema>;

export const ModelInputContractSchema = z.object({
  identifier: z.string(),
  trajectoryPreprocessing: z.string(),
  inputs: z.array(ModelInputTensorSchema),
  contextFeatures: z.array(z.string()),
}).strict();
export type ModelInputContract = z.infer<typeof ModelInputContractSchema>;

export const ModelValidationSummarySchema = z.object({
  passedAllGates: z.boolean(),
  modelSha256: Sha256Schema,
  corpusDigest: Sha256Schema,
  reportSha256: Sha256Schema,
  inputContractIdentifier: z.string(),
  policyVersion: z.string(),
  basis: z.literal('repository_synthetic'),
  falsePositiveRate: z.number().finite().min(0).max(1),
  benignWarningCount: z.number().int().nonnegative(),
  criticalMissCount: z.number().int().nonnegative(),
  independentTestGroups: z.number().int().positive(),
}).strict();
export type ModelValidationSummary = z.infer<typeof ModelValidationSummarySchema>;

export const ModelMetricsSchema = z.object({
  accuracy: z.number().finite().min(0).max(1).describe('Validation accuracy score'),
  f1Score: z.number().finite().min(0).max(1).describe('Validation F1 score'),
  latencyMs: z.number().finite().nonnegative().describe('Average inference latency in milliseconds'),
  memoryBudgetMb: z.number().finite().positive().describe('Peak runtime memory footprint in MB'),
}).strict();
export type ModelMetrics = z.infer<typeof ModelMetricsSchema>;

export const ModelMetadataSchema = z.object({
  version: z.string().min(1).describe('SemVer model release version, e.g. 1.1.0'),
  name: z.string().min(1).describe('Human-readable model identifier'),
  architecture: z.string().min(1).describe('Neural architecture description'),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).describe('SHA-256 hex cryptographic checksum of the ONNX binary'),
  fileSizeBytes: z.number().int().positive().describe('Model binary size in bytes'),
  releasedAt: z.string().datetime().describe('Release ISO timestamp'),
  minExtensionVersion: z.string().default('0.1.0').describe('Minimum compatible extension version'),
  features: z.array(z.string()).default(['x', 'y', 'dx', 'dy', 'v', 'theta']),
  metrics: ModelMetricsSchema,
  changelog: z.array(z.string()).default([]),
  downloadUrl: z.string().min(1).describe('Relative or absolute download URL for the ONNX binary'),
  inputContract: ModelInputContractSchema.nullable().optional(),
  validationSummary: ModelValidationSummarySchema.nullable().optional(),
}).strict();
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export const ModelSyncStateSchema = z.enum([
  'ONLINE_SYNCED',
  'ONLINE_UPDATE_AVAILABLE',
  'OFFLINE_FALLBACK',
  'UPDATING',
  'SYNC_ERROR',
]);
export type ModelSyncState = z.infer<typeof ModelSyncStateSchema>;

export const ModelSourceSchema = z.enum(['REMOTE_SYNCED', 'LOCAL_BUNDLED', 'CACHE_STORAGE']);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const ModelSyncStatusSchema = z.object({
  currentVersion: z.string(),
  latestAvailableVersion: z.string(),
  isLatest: z.boolean(),
  lastSyncAttempt: z.string().datetime(),
  syncState: ModelSyncStateSchema,
  backendReachable: z.boolean(),
  modelSource: ModelSourceSchema,
  activeMetadata: ModelMetadataSchema.nullable().optional(),
});
export type ModelSyncStatus = z.infer<typeof ModelSyncStatusSchema>;

export const CheckUpdateRequestSchema = z.object({
  currentVersion: z.string().describe('Currently active client model SemVer'),
  currentSha256: z.string().nullable().optional().describe('SHA-256 hash of active client model'),
  extensionVersion: z.string().nullable().optional(),
  supportedInputContracts: z.array(z.string()).nullable().optional(),
}).strict();
export type CheckUpdateRequest = z.infer<typeof CheckUpdateRequestSchema>;

export const CheckUpdateResponseSchema = z.object({
  updateAvailable: z.boolean(),
  currentVersion: z.string(),
  latestMetadata: ModelMetadataSchema,
});
export type CheckUpdateResponse = z.infer<typeof CheckUpdateResponseSchema>;

import { z } from 'zod';
import {
  PointerEventPointSchema,
  KeystrokeDynamicsSchema,
  DOMInteractionEventSchema,
  ViewportCaptureSpecSchema,
  ElementBoundingBoxSchema,
} from './telemetry.js';

export const TargetBrandClassSchema = z.enum([
  'Microsoft',
  'Google',
  'Apple',
  'PayPal',
  'Bank of America',
  'Amazon',
  'Facebook',
  'Netflix',
  'Chase',
  'Wells Fargo',
  'Adobe',
  'Yahoo',
  'eBay',
  'Steam',
  'LinkedIn',
  'DHL',
  'Dropbox',
  'DocuSign',
  'Coinbase',
  'WhatsApp',
  'Generic Benign',
  'None',
]);
export type TargetBrandClass = z.infer<typeof TargetBrandClassSchema>;

export const VisualElementTypeSchema = z.enum([
  'logo',
  'input_credential',
  'input_generic',
  'button_submit',
  'security_badge',
  'captcha',
]);
export type VisualElementType = z.infer<typeof VisualElementTypeSchema>;

export const LogoGroundingSpecSchema = z.object({
  brandName: TargetBrandClassSchema,
  brandId: z.number().int().nonnegative().describe('Numerical index of target brand'),
  boundingBox: ElementBoundingBoxSchema,
  confidence: z.number().min(0).max(1),
  domainMatchesBrand: z.boolean().describe('True if domain is an official domain for this brand'),
});
export type LogoGroundingSpec = z.infer<typeof LogoGroundingSpecSchema>;

export const ImageDetectionAnnotationSchema = z.object({
  category: VisualElementTypeSchema,
  boundingBox: ElementBoundingBoxSchema,
  confidence: z.number().min(0).max(1),
});
export type ImageDetectionAnnotation = z.infer<typeof ImageDetectionAnnotationSchema>;

export const DatasetProvenanceSchema = z.object({
  sourceType: z.enum(['repository_fixture', 'synthetic', 'mock', 'fetched_metadata', 'public_feed', 'research_agent', 'unknown']),
  labelSource: z.enum(['manual_fixture', 'synthetic_scenario', 'heuristic', 'verified_feed', 'llm_research', 'unknown']),
  labelConfidence: z.number().finite().min(0).max(1),
  labelReason: z.string().max(256),
  baseSampleId: z.string().max(256).nullable().optional(),
  groupId: z.string().max(256).nullable().optional(),
  modalities: z.record(z.string(), z.enum(['observed', 'synthetic', 'missing'])).default({}),
}).strict();
export type DatasetProvenance = z.infer<typeof DatasetProvenanceSchema>;

export const MultimodalDatasetSampleSchema = z.object({
  sampleId: z.string().uuid(),
  label: z.number().finite().min(0).max(1).describe('0.0 = Benign, 1.0 = Phishing'),
  url: z.string().min(1),
  domain: z.string().min(1),
  targetBrand: TargetBrandClassSchema.nullable().optional(),
  pointerSeries: z.array(PointerEventPointSchema).default([]),
  keystrokes: z.array(KeystrokeDynamicsSchema).default([]),
  domEvents: z.array(DOMInteractionEventSchema).default([]),
  viewportCapture: ViewportCaptureSpecSchema.nullable().optional(),
  logoDetections: z.array(LogoGroundingSpecSchema).default([]),
  imageDetections: z.array(ImageDetectionAnnotationSchema).default([]),
  extractedFeatures: z.record(z.string(), z.array(z.number().finite())).nullable().optional(),
  createdAt: z.string().datetime(),
  provenance: DatasetProvenanceSchema.nullable().optional(),
}).strict();
export type MultimodalDatasetSample = z.infer<typeof MultimodalDatasetSampleSchema>;

export const DatasetSplitStatsSchema = z.object({
  totalSamples: z.number().int().nonnegative(),
  phishingSamples: z.number().int().nonnegative(),
  benignSamples: z.number().int().nonnegative(),
  samplesWithLogo: z.number().int().nonnegative(),
  samplesWithScreenshot: z.number().int().nonnegative(),
});
export type DatasetSplitStats = z.infer<typeof DatasetSplitStatsSchema>;

export const DatasetManifestSchema = z.object({
  datasetName: z.string(),
  datasetVersion: z.string(),
  createdAt: z.string(),
  totalSamples: z.number().int().nonnegative(),
  splits: z.record(z.string(), DatasetSplitStatsSchema),
  modalitiesSupported: z.array(z.string()),
  sotaBenchmarkTargets: z.record(z.string(), z.number()),
  featureDimensions: z.record(z.string(), z.number()),
});
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

export const SOTABenchmarkReportSchema = z.object({
  modelName: z.string(),
  evaluatedAt: z.string(),
  datasetVersion: z.string(),
  passedSotaBenchmark: z.boolean(),
  accuracy: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1Score: z.number().min(0).max(1),
  falsePositiveRate: z.number().min(0).max(1),
  rocAuc: z.number().min(0).max(1),
  brierScore: z.number().min(0).max(1),
  latencyMsAvg: z.number().nonnegative(),
  benchmarkThresholds: z.record(z.string(), z.number()),
  gateFailures: z.array(z.string()).default([]),
});
export type SOTABenchmarkReport = z.infer<typeof SOTABenchmarkReportSchema>;

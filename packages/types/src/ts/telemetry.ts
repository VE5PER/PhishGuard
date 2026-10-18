import { z } from 'zod';

export const PointerEventTypeSchema = z.enum(['move', 'down', 'up']);
export type PointerEventType = z.infer<typeof PointerEventTypeSchema>;

export const PointerEventPointSchema = z.object({
  x: z.number().finite().min(0).max(1).describe('Normalized viewport coordinate x in range [0, 1]'),
  y: z.number().finite().min(0).max(1).describe('Normalized viewport coordinate y in range [0, 1]'),
  dx: z.number().finite().describe('Horizontal displacement from previous point'),
  dy: z.number().finite().describe('Vertical displacement from previous point'),
  velocity: z.number().finite().nonnegative().describe('Instantaneous velocity in px/ms'),
  acceleration: z.number().finite().describe('Instantaneous acceleration in px/ms^2'),
  angle: z.number().finite().describe('Trajectory direction angle in radians [-pi, pi]'),
  timestamp: z.number().finite().nonnegative().describe('Relative timestamp in milliseconds since session start'),
  eventType: PointerEventTypeSchema,
}).strict();
export type PointerEventPoint = z.infer<typeof PointerEventPointSchema>;

export const KeystrokeCategorySchema = z.enum(['ALPHANUMERIC', 'BACKSPACE', 'CONTROL', 'OTHER']);
export type KeystrokeCategory = z.infer<typeof KeystrokeCategorySchema>;

export const KeystrokeDynamicsSchema = z.object({
  category: KeystrokeCategorySchema.describe('GDPR-safe generalized key category; no raw key characters recorded'),
  dwellTimeMs: z.number().finite().nonnegative().describe('Dwell time: duration between keydown and keyup in ms'),
  flightTimeMs: z.number().finite().nonnegative().describe('Flight time: duration between previous keyup and current keydown in ms'),
  timestamp: z.number().finite().nonnegative().describe('Relative timestamp in milliseconds'),
}).strict();
export type KeystrokeDynamics = z.infer<typeof KeystrokeDynamicsSchema>;

export const DOMInteractionTypeSchema = z.enum(['click', 'paste', 'focus', 'hover']);
export type DOMInteractionType = z.infer<typeof DOMInteractionTypeSchema>;

export const DOMEvidenceSourceSchema = z.enum(['observed_interaction', 'topology_scan', 'legacy']);
export type DOMEvidenceSource = z.infer<typeof DOMEvidenceSourceSchema>;

export const CoveredControlTypeSchema = z.enum(['password', 'submit', 'other', 'none']);
export type CoveredControlType = z.infer<typeof CoveredControlTypeSchema>;

export const CredentialFrameEvidenceSchema = z.enum(['observed', 'unverified', 'none']);
export type CredentialFrameEvidence = z.infer<typeof CredentialFrameEvidenceSchema>;

export const ElementBoundingBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();
export type ElementBoundingBox = z.infer<typeof ElementBoundingBoxSchema>;

export const DOMInteractionEventSchema = z.object({
  eventType: DOMInteractionTypeSchema,
  targetBoundingBox: ElementBoundingBoxSchema,
  isZeroOpacity: z.boolean().describe('True if element computed opacity is 0 or visibility hidden'),
  isCrossOriginIframe: z.boolean().describe('True if event crossed into or originated from cross-origin iframe'),
  isPasswordInput: z.boolean().describe('True if element is an input of type password'),
  isPasteIntoPassword: z.boolean().describe('True if a paste action was directed into a password field'),
  elementSelector: z.string().describe('Sanitized DOM hierarchy selector path'),
  timestamp: z.number().finite().nonnegative().describe('Relative timestamp in milliseconds'),
  evidenceSource: DOMEvidenceSourceSchema.default('legacy'),
  evidenceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
  isHitTestIntercepting: z.boolean().default(false),
  coveredControlType: CoveredControlTypeSchema.default('none'),
  credentialFrameEvidence: CredentialFrameEvidenceSchema.default('none'),
}).strict();
export type DOMInteractionEvent = z.infer<typeof DOMInteractionEventSchema>;

export const ViewportCaptureSpecSchema = z.object({
  width: z.number().int().positive().describe('Rendered capture width (typically 256 or 384 px)'),
  height: z.number().int().positive().describe('Rendered capture height (typically 256 or 384 px)'),
  mimeType: z.enum(['image/webp', 'image/jpeg', 'image/png']),
  base64Data: z.string().min(1).describe('Base64-encoded visual capture image buffer'),
  devicePixelRatio: z.number().finite().positive().default(1),
  scrollOffset: z.object({
    x: z.number().finite().nonnegative().default(0),
    y: z.number().finite().nonnegative().default(0),
  }).strict().default({}),
  capturedAt: z.number().finite().nonnegative(),
}).strict();
export type ViewportCaptureSpec = z.infer<typeof ViewportCaptureSpecSchema>;

export const InteractionTelemetryPayloadSchema = z.object({
  telemetryId: z.string().uuid().describe('Unique telemetry session identifier'),
  url: z.string().url().describe('Full canonical URL of the evaluated webpage'),
  domain: z.string().min(1).describe('Hostname / domain of the webpage'),
  pageTitle: z.string().default(''),
  sessionDurationMs: z.number().finite().nonnegative(),
  pointerSeries: z.array(PointerEventPointSchema).default([]).describe('Normalized pointer movement and click points'),
  keystrokes: z.array(KeystrokeDynamicsSchema).default([]).describe('Privacy-preserving keystroke timings'),
  domEvents: z.array(DOMInteractionEventSchema).default([]).describe('Suspicious or relevant DOM topological events'),
  viewportCapture: ViewportCaptureSpecSchema.nullable().optional().describe('Visual page snapshot captured on idle'),
  hasCredentialField: z.boolean().default(false).describe('True when the page contains a password input'),
  clientTimestamp: z.string().datetime().describe('Client ISO timestamp when payload was generated'),
}).strict();
export type InteractionTelemetryPayload = z.infer<typeof InteractionTelemetryPayloadSchema>;

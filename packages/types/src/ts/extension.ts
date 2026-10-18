import { z } from 'zod';

export const ExtensionDistributionChannelSchema = z.object({
  channel: z.string().describe('Channel identifier, e.g. chrome_web_store, direct_crx'),
  label: z.string().describe('Human-readable channel title'),
  url: z.string().describe('Relative or absolute download URL'),
  format: z.string().describe('Package format: zip or crx'),
});
export type ExtensionDistributionChannel = z.infer<typeof ExtensionDistributionChannelSchema>;

export const ExtensionReleaseMetaSchema = z.object({
  name: z.string().describe('Extension display name'),
  version: z.string().min(1).describe('SemVer extension release version, e.g. 0.1.0'),
  extension_id: z.string().optional().describe('Deterministic 32-char extension ID'),
  filename: z.string().describe('Filename of store-ready zip'),
  versioned_filename: z.string().optional().describe('Filename of versioned zip archive'),
  download_url: z.string().describe('Relative or absolute download URL for zip package'),
  crx_filename: z.string().nullable().optional().describe('Filename of signed crx package'),
  crx_download_url: z.string().nullable().optional().describe('Relative or absolute URL for crx package'),
  updates_url: z.string().optional().describe('Chromium autoupdate protocol XML URL'),
  sha256: z.string().describe('SHA-256 hash of zip package'),
  size_bytes: z.number().nonnegative().describe('Size of zip package in bytes'),
  size_formatted: z.string().optional().describe('Human readable zip file size'),
  crx_sha256: z.string().nullable().optional().describe('SHA-256 hash of crx package'),
  crx_size_bytes: z.number().nonnegative().optional().describe('Size of crx package in bytes'),
  crx_size_formatted: z.string().nullable().optional().describe('Human readable crx file size'),
  webstore_filename: z.string().nullable().optional().describe('Filename of Chrome Web Store zip (no key / update_url)'),
  webstore_download_url: z.string().nullable().optional().describe('Relative or absolute URL for Chrome Web Store zip'),
  built_at: z.string().optional().describe('ISO timestamp when package was built'),
  manifest_version: z.number().int().optional().describe('Manifest specification version (default 3)'),
  supported_browsers: z.array(z.string()).optional().describe('Supported browser targets'),
  changelog: z.array(z.string()).optional().describe('List of changes in this release'),
  distribution_channels: z.array(ExtensionDistributionChannelSchema).optional().describe('Available download channels'),
});
export type ExtensionReleaseMeta = z.infer<typeof ExtensionReleaseMetaSchema>;

export const ExtensionUpdateCheckMethodSchema = z.enum([
  'API_POLL',
  'NATIVE_RUNTIME',
  'MANUAL_CHECK',
  'OFFLINE_CACHE',
]);
export type ExtensionUpdateCheckMethod = z.infer<typeof ExtensionUpdateCheckMethodSchema>;

export const ExtensionUpdateChannelSchema = z.enum([
  'NATIVE',
  'MANUAL_CRX',
  'MANUAL_UNPACKED',
]);
export type ExtensionUpdateChannel = z.infer<typeof ExtensionUpdateChannelSchema>;

export const ExtensionUpdateStatusSchema = z.object({
  currentVersion: z.string().describe('Currently installed extension version'),
  latestVersion: z.string().describe('Latest available extension version reported by backend'),
  updateAvailable: z.boolean().describe('True if latestVersion > currentVersion'),
  lastChecked: z.string().datetime().describe('Timestamp of last update check'),
  checkMethod: ExtensionUpdateCheckMethodSchema.describe('Method used to perform update check'),
  backendReachable: z.boolean().describe('Whether the backend artifact registry was reachable'),
  releaseMeta: ExtensionReleaseMetaSchema.optional().describe('Detailed release metadata if available'),
  statusMessage: z.string().optional().describe('Human-readable status summary message'),
  installPromptShown: z.boolean().default(false).describe('Whether user has been notified of this update'),
  updateChannel: ExtensionUpdateChannelSchema.optional().describe('How this install receives updates'),
  nativeUpdateReady: z.boolean().default(false).describe('True when Chrome has downloaded an update awaiting restart'),
});
export type ExtensionUpdateStatus = z.infer<typeof ExtensionUpdateStatusSchema>;

export const ExtensionVersionItemSchema = z.object({
  version: z.string().describe('SemVer version string'),
  is_latest: z.boolean().default(false),
  crx_download_url: z.string().optional(),
  zip_download_url: z.string().optional(),
  sha256: z.string().optional(),
  crx_sha256: z.string().optional(),
  built_at: z.string().optional(),
});
export type ExtensionVersionItem = z.infer<typeof ExtensionVersionItemSchema>;

export const ExtensionVersionsListSchema = z.object({
  versions: z.array(ExtensionVersionItemSchema),
  latest: z.string().optional(),
});
export type ExtensionVersionsList = z.infer<typeof ExtensionVersionsListSchema>;

export const WarningPresentationTypeSchema = z.enum([
  'smart',
  'overlay',
  'banner',
  'notification',
]);
export type WarningPresentationType = z.infer<typeof WarningPresentationTypeSchema>;

export const ExtensionWarningConfigSchema = z.object({
  warningType: WarningPresentationTypeSchema.default('smart'),
  snoozeDurationMinutes: z.number().int().positive().default(15),
  snoozedDomains: z.record(z.string(), z.number()).default({}),
  acknowledgedDomains: z.record(z.string(), z.number()).default({}),
});
export type ExtensionWarningConfig = z.infer<typeof ExtensionWarningConfigSchema>;


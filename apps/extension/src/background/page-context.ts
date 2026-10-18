import type { DOMInteractionEvent, InteractionTelemetryPayload } from '@phishguard/types';
import type { PreparedTrajectory } from './trajectory-preprocessor.js';

export const PAGE_CONTEXT_FEATURES = [
  'url_userinfo', 'hostname_brand_mismatch', 'path_query_brand_mention', 'credential_present',
  'credential_overlay', 'submit_overlay', 'other_overlay', 'observed_cross_origin_credential',
  'unverified_cross_origin_frame', 'password_paste', 'pointer_coverage', 'duration_coverage',
  'trajectory_available', 'visual_available', 'page_context_available', 'https',
] as const;

export const BRAND_DOMAINS: Record<string, readonly string[]> = {
  microsoft: ['microsoft.com', 'live.com', 'login.microsoftonline.com', 'office.com', 'outlook.com', 'msn.com'],
  google: ['google.com', 'accounts.google.com', 'gmail.com', 'youtube.com'],
  apple: ['apple.com', 'appleid.apple.com', 'icloud.com'],
  paypal: ['paypal.com'],
  bankofamerica: ['bankofamerica.com', 'bofa.com'],
  amazon: ['amazon.com', 'aws.amazon.com'],
  facebook: ['facebook.com', 'fb.com', 'meta.com', 'instagram.com'],
  netflix: ['netflix.com'],
  chase: ['chase.com', 'jpmorganchase.com'],
  wellsfargo: ['wellsfargo.com'],
  adobe: ['adobe.com'],
  yahoo: ['yahoo.com', 'login.yahoo.com'],
  ebay: ['ebay.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  linkedin: ['linkedin.com'],
  dhl: ['dhl.com'],
  dropbox: ['dropbox.com'],
  docusign: ['docusign.com'],
  coinbase: ['coinbase.com'],
  whatsapp: ['whatsapp.com', 'web.whatsapp.com'],
};

export const BRAND_LABELS: Record<string, string> = {
  microsoft: 'Microsoft',
  google: 'Google',
  apple: 'Apple',
  paypal: 'PayPal',
  bankofamerica: 'Bank of America',
  amazon: 'Amazon',
  facebook: 'Facebook',
  netflix: 'Netflix',
  chase: 'Chase',
  wellsfargo: 'Wells Fargo',
  adobe: 'Adobe',
  yahoo: 'Yahoo',
  ebay: 'eBay',
  steam: 'Steam',
  linkedin: 'LinkedIn',
  dhl: 'DHL',
  dropbox: 'Dropbox',
  docusign: 'DocuSign',
  coinbase: 'Coinbase',
  whatsapp: 'WhatsApp',
};

export function sanitizeDisplayedBrands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' &&
      Object.prototype.hasOwnProperty.call(BRAND_DOMAINS, entry)) {
      found.add(entry);
    }
  }
  return [...found].sort().slice(0, 4);
}

export interface EvidenceEvent extends Pick<DOMInteractionEvent,
  'isZeroOpacity' | 'isCrossOriginIframe' | 'isPasswordInput' | 'isPasteIntoPassword' | 'elementSelector'> {
  evidenceId?: string | null;
  evidenceSource?: 'observed_interaction' | 'topology_scan' | 'legacy';
  isHitTestIntercepting?: boolean;
  coveredControlType?: 'password' | 'submit' | 'other' | 'none';
  credentialFrameEvidence?: 'observed' | 'unverified' | 'none';
}

export interface PageEvidence {
  context: Float32Array;
  available: boolean;
  hostname: string;
  brand: string | null;
  deceptiveHost: boolean;
  credentialTraps: number;
  submitTraps: number;
  otherTraps: number;
  observedCredentialFrame: boolean;
  reasons: string[];
}

export function normalizeHostname(host: string): string {
  if (/[/?#@]/.test(host)) return '';
  try {
    const authority = host.includes(':') && !host.startsWith('[') && host.split(':').length > 2 ? `[${host}]` : host;
    return new URL(`https://${authority.replace(/\.$/, '')}`).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

export function authorizedBrandHost(host: string, brand: string): boolean {
  return (BRAND_DOMAINS[brand] ?? []).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function deduplicateEvidence(events: readonly EvidenceEvent[]): EvidenceEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const identity = event.evidenceId ?? event.elementSelector;
    const key = `${identity}|${event.coveredControlType ?? 'none'}|${event.credentialFrameEvidence ?? 'none'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function preparePageContext(
  payload: Pick<InteractionTelemetryPayload, 'url' | 'domain' | 'domEvents' | 'hasCredentialField'>,
  trajectory: PreparedTrajectory,
  visualAvailable: boolean
): PageEvidence {
  const context = new Float32Array(16);
  const base: PageEvidence = {
    context, available: false, hostname: '', brand: null, deceptiveHost: false,
    credentialTraps: 0, submitTraps: 0, otherTraps: 0, observedCredentialFrame: false, reasons: [],
  };
  let url: URL;
  try {
    url = new URL(payload.url);
    if (!['http:', 'https:'].includes(url.protocol)) return base;
  } catch {
    return base;
  }
  const host = normalizeHostname(url.hostname);
  if (normalizeHostname(payload.domain) !== host) return base;
  const tokens = host.split(/[.-]/);
  const brand = Object.keys(BRAND_DOMAINS).find((name) => tokens.includes(name) && !authorizedBrandHost(host, name)) ?? null;
  const mentionTokens = `${url.pathname} ${url.search}`.toLowerCase().split(/[^a-z0-9]+/);
  const events = deduplicateEvidence(payload.domEvents);
  const traps = events.filter((event) => event.evidenceSource !== 'legacy' && !!event.evidenceSource &&
    event.isZeroOpacity && event.isHitTestIntercepting);
  const credentialTraps = traps.filter((event) => event.coveredControlType === 'password').length;
  const submitTraps = traps.filter((event) => event.coveredControlType === 'submit').length;
  const otherTraps = traps.filter((event) => event.coveredControlType === 'other').length;
  const observedCredentialFrame = events.some((event) => event.evidenceSource === 'observed_interaction' &&
    event.credentialFrameEvidence === 'observed' && event.isCrossOriginIframe && event.isPasswordInput);
  const deceptiveHost = brand !== null && tokens.some((token) =>
    ['verify', 'signin', 'login', 'security', 'secure', 'recovery', 'account'].includes(token));
  context.set([
    Number(Boolean(url.username || url.password)), Number(brand !== null),
    Number(Object.keys(BRAND_DOMAINS).some((name) => mentionTokens.includes(name))),
    Number(Boolean(payload.hasCredentialField)), Number(credentialTraps > 0), Number(submitTraps > 0),
    Number(otherTraps > 0), Number(observedCredentialFrame),
    Number(events.some((event) => event.isCrossOriginIframe && event.credentialFrameEvidence !== 'observed')),
    Number(events.some((event) => event.isPasteIntoPassword)),
    Math.min(trajectory.validPointCount / 128, 1), Math.min(trajectory.durationMs / 2000, 1),
    Number(trajectory.available), Number(visualAvailable), 1, Number(url.protocol === 'https:'),
  ]);
  return { ...base, context, available: true, hostname: host, brand, deceptiveHost,
    credentialTraps, submitTraps, otherTraps, observedCredentialFrame };
}

/**
 * PhishGuard Unified Backend Configuration
 *
 * Merges and reuses GATEWAY_DOMAIN and BACKEND_URL as a single source of truth.
 * Powers all frontend backend connectivity:
 * - Download: Model binary downloads & extension package downloads
 * - Update: Model version synchronization & extension releases / updates.xml
 * - Escalate: Voluntary cloud escalation gateway (/v1/escalate)
 * - Probing: Health and runtime service discovery (/health)
 */

declare const __BACKEND_URL__: string | undefined;

interface ImportMetaWithEnv {
  env?: {
    BACKEND_URL?: string;
    GATEWAY_DOMAIN?: string;
    VITE_BACKEND_URL?: string;
    VITE_GATEWAY_DOMAIN?: string;
    [key: string]: unknown;
  };
}

export function normalizeBackendUrl(raw: string | undefined): string {
  if (!raw) return '';
  let trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    // If it's a loopback/local address, default to http://, otherwise https://
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(trimmed)) {
      trimmed = `http://${trimmed}`;
    } else {
      trimmed = `https://${trimmed}`;
    }
  }
  return trimmed.replace(/\/+$/, '');
}

export function resolveBackendUrl(): string {
  // 1. Injected via Vite compile-time define
  if (typeof __BACKEND_URL__ !== 'undefined' && __BACKEND_URL__) {
    const normalized = normalizeBackendUrl(__BACKEND_URL__);
    if (normalized) return normalized;
  }

  // 2. Injected via Vite import.meta.env
  try {
    const meta = import.meta as unknown as ImportMetaWithEnv;
    const candidate =
      meta?.env?.BACKEND_URL ||
      meta?.env?.GATEWAY_DOMAIN ||
      meta?.env?.VITE_BACKEND_URL ||
      meta?.env?.VITE_GATEWAY_DOMAIN;
    if (candidate) {
      const normalized = normalizeBackendUrl(String(candidate));
      if (normalized) return normalized;
    }
  } catch {
    // import.meta not available
  }

  // 3. Fallback to process.env (Node / tsx tests)
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env) {
    const candidate =
      proc.env.BACKEND_URL ||
      proc.env.GATEWAY_DOMAIN ||
      proc.env.VITE_BACKEND_URL ||
      proc.env.VITE_GATEWAY_DOMAIN ||
      proc.env.EXTENSION_UPDATE_BASE_URL;
    if (candidate) {
      const normalized = normalizeBackendUrl(candidate);
      if (normalized) return normalized;
    }
  }

  return '';
}

export const BUILD_BACKEND_URL = resolveBackendUrl();
export const DEFAULT_BACKEND_URL = BUILD_BACKEND_URL || 'http://localhost:8000';

/**
 * Passive scan for brand logos displayed on credential pages.
 * Returns only known brand keys (never raw label text) so no page content
 * leaves the device beyond a bounded, sanitized brand list.
 */

import { BRAND_DOMAINS, sanitizeDisplayedBrands } from '../background/page-context.js';

const MAX_CANDIDATES = 200;
const KNOWN_BRANDS = Object.keys(BRAND_DOMAINS);

function isCandidateVisible(element: Element, view: Window | null): boolean {
  try {
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  } catch {
    return false;
  }
  if (!view || typeof view.getComputedStyle !== 'function') return true;
  try {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  } catch {
    return false;
  }
  return true;
}

function matchBrandLabel(label: string, matches: Set<string>): void {
  const normalized = label.toLowerCase();
  if (!normalized) return;
  const tokens = normalized.split(/[^a-z0-9]+/);
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  for (const brand of KNOWN_BRANDS) {
    if (tokens.includes(brand) || compact === brand) {
      matches.add(brand);
    }
  }
}

export function scanDisplayedBrandLogos(doc: Document): string[] {
  if (!doc || typeof doc.querySelector !== 'function' || typeof doc.querySelectorAll !== 'function') {
    return [];
  }
  try {
    if (!doc.querySelector('input[type="password"]')) return [];
  } catch {
    return [];
  }
  const view: Window | null =
    doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const matches = new Set<string>();
  let scanned = 0;
  const query = (selector: string): Element[] => {
    if (scanned >= MAX_CANDIDATES) return [];
    try {
      const out: Element[] = [];
      for (const el of doc.querySelectorAll(selector)) {
        if (scanned >= MAX_CANDIDATES) break;
        scanned += 1;
        out.push(el);
      }
      return out;
    } catch {
      return [];
    }
  };

  for (const el of query('img[alt]')) {
    const label = el.getAttribute('alt');
    if (label && isCandidateVisible(el, view)) matchBrandLabel(label, matches);
  }
  for (const el of query('img[src]')) {
    const src = el.getAttribute('src');
    if (!src || src.startsWith('data:') || !isCandidateVisible(el, view)) continue;
    try {
      const base = doc.baseURI || view?.location?.href || 'https://localhost/';
      const filename = new URL(src, base).pathname.split('/').pop() ?? '';
      if (filename) matchBrandLabel(decodeURIComponent(filename), matches);
    } catch {
      // unparsable src is not brand evidence
    }
  }
  for (const el of query('[role="img"][aria-label]')) {
    const label = el.getAttribute('aria-label');
    if (label && isCandidateVisible(el, view)) matchBrandLabel(label, matches);
  }
  for (const el of query('svg[aria-label]')) {
    const label = el.getAttribute('aria-label');
    if (label && isCandidateVisible(el, view)) matchBrandLabel(label, matches);
  }
  for (const titleEl of query('svg title')) {
    const owner = typeof titleEl.closest === 'function'
      ? titleEl.closest('svg')
      : titleEl.parentElement;
    const text = titleEl.textContent;
    if (text && owner && isCandidateVisible(owner, view)) matchBrandLabel(text, matches);
  }
  return sanitizeDisplayedBrands([...matches]);
}

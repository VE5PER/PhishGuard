/**
 * On-device visual capture for the vision modality.
 *
 * Frames are downscaled in memory and are never stored, logged or attached to telemetry.
 * Normalization is shared with training: RGB, CHW, float32 in [0, 1], no mean/std, with the
 * 64x64 bilinear-style downscale done by createImageBitmap.
 */

import type { VisionUnavailableReason } from './types.js';

export const VISION_SIZE = 64;
export const UPLOAD_MAX_DIMENSION = 2048;
export const UPLOAD_MAX_BYTES = 1_500_000;
const UPLOAD_JPEG_QUALITY = 0.85;
const UPLOAD_JPEG_RETRY_QUALITY = 0.65;
export const CAPTURE_INTERVAL_MS = 5000;
// Chrome enforces MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2; serializing
// capture calls with this minimum spacing keeps two back-to-back requests
// inside the quota.
export const CAPTURE_MIN_SPACING_MS = 550;

const lastCaptureByTab = new Map<number, number>();
let captureCallQueue: Promise<unknown> = Promise.resolve();
let lastCaptureCallStartedAt = 0;

export function resetVisionRateLimit(): void {
  lastCaptureByTab.clear();
  lastCaptureCallStartedAt = 0;
}

export interface VisualCaptureResult {
  tensor: Float32Array | null;
  status: 'captured' | 'rate_limited' | 'unavailable';
  capturedAt: number | null;
  reason: VisionUnavailableReason | null;
}

export function rgbaToChwTensor(data: ArrayLike<number>, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = data[i * 4] / 255;
    out[plane + i] = data[i * 4 + 1] / 255;
    out[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return out;
}

async function canCapture(
  tabId: number,
  windowId: number,
  expectedUrl?: string
): Promise<VisionUnavailableReason | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.get || !chrome.windows?.get || !chrome.tabs?.captureVisibleTab) {
    return 'missing_api';
  }
  let tab: chrome.tabs.Tab | null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'capture_api_failure';
  }
  if (!tab || !tab.active || tab.windowId !== windowId) return 'inactive_tab';
  if (expectedUrl !== undefined && tab.url !== expectedUrl) return 'page_changed';
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return 'restricted_url';
  let win: chrome.windows.Window | null;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return 'capture_api_failure';
  }
  // An open action popup makes the window report focused: false while the
  // tab is still perfectly capturable; only a minimized window cannot yield
  // a meaningful frame.
  if (!win || win.state === 'minimized') return 'unfocused_window';
  return null;
}

async function captureBlob(windowId: number, quality: number): Promise<Blob> {
  const run = captureCallQueue.then(async () => {
    const waitMs = lastCaptureCallStartedAt + CAPTURE_MIN_SPACING_MS - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastCaptureCallStartedAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });
    return (await fetch(dataUrl)).blob();
  });
  captureCallQueue = run.catch(() => {});
  return run;
}

export async function captureVisualTensorWithStatus(
  tabId: number,
  windowId: number,
  force: boolean = false,
  expectedUrl?: string
): Promise<VisualCaptureResult> {
  const initialReason = await canCapture(tabId, windowId, expectedUrl);
  if (initialReason) return { tensor: null, status: 'unavailable', capturedAt: null, reason: initialReason };

  const now = Date.now();
  const last = lastCaptureByTab.get(tabId);
  if (!force && last !== undefined && now - last < CAPTURE_INTERVAL_MS) {
    return { tensor: null, status: 'rate_limited', capturedAt: last, reason: 'rate_limited' };
  }

  let blob: Blob;
  try {
    blob = await captureBlob(windowId, 50);
  } catch {
    return { tensor: null, status: 'unavailable', capturedAt: null, reason: 'capture_api_failure' };
  }
  const afterCaptureReason = await canCapture(tabId, windowId, expectedUrl);
  if (afterCaptureReason) {
    return { tensor: null, status: 'unavailable', capturedAt: null, reason: afterCaptureReason };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: VISION_SIZE,
      resizeHeight: VISION_SIZE,
      resizeQuality: 'medium',
    });
  } catch {
    return { tensor: null, status: 'unavailable', capturedAt: null, reason: 'decode_canvas_failure' };
  }
  try {
    const canvas = new OffscreenCanvas(VISION_SIZE, VISION_SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { tensor: null, status: 'unavailable', capturedAt: null, reason: 'decode_canvas_failure' };
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, VISION_SIZE, VISION_SIZE);
    const tensor = rgbaToChwTensor(data, VISION_SIZE, VISION_SIZE);
    const afterDecodeReason = await canCapture(tabId, windowId, expectedUrl);
    if (afterDecodeReason) {
      return { tensor: null, status: 'unavailable', capturedAt: null, reason: afterDecodeReason };
    }
    lastCaptureByTab.set(tabId, now);
    return { tensor, status: 'captured', capturedAt: now, reason: null };
  } catch {
    return { tensor: null, status: 'unavailable', capturedAt: null, reason: 'decode_canvas_failure' };
  } finally {
    try {
      bitmap.close();
    } catch {}
  }
}

export async function captureVisualTensor(
  tabId: number,
  windowId: number,
  force: boolean = false,
  expectedUrl?: string
): Promise<Float32Array | null> {
  return (await captureVisualTensorWithStatus(tabId, windowId, force, expectedUrl)).tensor;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function captureScreenshotForUpload(
  tabId: number,
  windowId: number,
  expectedUrl?: string
): Promise<string | null> {
  try {
    if (await canCapture(tabId, windowId, expectedUrl)) return null;

    const blob = await captureBlob(windowId, 85);
    if (await canCapture(tabId, windowId, expectedUrl)) return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, UPLOAD_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);

      let jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY });
      if (jpeg.size > UPLOAD_MAX_BYTES) {
        jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: UPLOAD_JPEG_RETRY_QUALITY });
        if (jpeg.size > UPLOAD_MAX_BYTES) return null;
      }
      const screenshot = `data:image/jpeg;base64,${arrayBufferToBase64(await jpeg.arrayBuffer())}`;
      if (await canCapture(tabId, windowId, expectedUrl)) return null;
      return screenshot;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

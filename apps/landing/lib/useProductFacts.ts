"use client";

import { useEffect, useState } from "react";
import { DEFAULT_FACTS, fmtMB, type ProductFacts } from "@/lib/facts";

interface ExtensionLatestResponse {
  version?: string;
  extension_id?: string;
  sha256?: string;
  size_bytes?: number;
  size_formatted?: string;
  crx_sha256?: string;
  crx_size_bytes?: number;
  crx_size_formatted?: string;
}

interface ModelLatestResponse {
  version?: string;
  sha256?: string;
  fileSizeBytes?: number;
}

let factsPromise: Promise<ProductFacts> | null = null;
let resolvedFacts: ProductFacts = DEFAULT_FACTS;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function loadFacts(): Promise<ProductFacts> {
  if (!factsPromise) {
    factsPromise = Promise.all([
      fetchJson<ExtensionLatestResponse>("/v1/extension/latest"),
      fetchJson<ModelLatestResponse>("/v1/models/latest"),
    ]).then(([ext, model]) => {
      const next: ProductFacts = { ...DEFAULT_FACTS };
      if (ext) {
        next.extensionVersion = ext.version || next.extensionVersion;
        next.extensionId = ext.extension_id || next.extensionId;
        next.zipSha256 = ext.sha256 || next.zipSha256;
        next.zipSize = ext.size_formatted || (ext.size_bytes ? fmtMB(ext.size_bytes) : next.zipSize);
        next.crxSha256 = ext.crx_sha256 || next.crxSha256;
        next.crxSize = ext.crx_size_formatted || (ext.crx_size_bytes ? fmtMB(ext.crx_size_bytes) : next.crxSize);
      }
      if (model) {
        next.modelVersion = model.version || next.modelVersion;
        next.modelSha256 = model.sha256 || next.modelSha256;
        next.modelSizeBytes = model.fileSizeBytes || next.modelSizeBytes;
      }
      resolvedFacts = next;
      return next;
    });
  }
  return factsPromise;
}

export function useProductFacts(): ProductFacts {
  const [facts, setFacts] = useState<ProductFacts>(resolvedFacts);

  useEffect(() => {
    let active = true;
    loadFacts().then((next) => {
      if (active) setFacts(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return facts;
}

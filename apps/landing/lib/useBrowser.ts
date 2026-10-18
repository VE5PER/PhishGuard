"use client";

import { useEffect, useState } from "react";
import { detectBrowser, type BrowserInfo } from "@/lib/browserDetection";

const DEFAULT_BROWSER: BrowserInfo = {
  id: "chrome",
  name: "Google Chrome",
  actionText: "Add to Chrome",
  settingsUrl: "chrome://extensions",
  storeName: "Chrome Web Store",
  isMobile: false,
  os: "unknown",
};

export function useBrowser(): BrowserInfo {
  const [browser, setBrowser] = useState<BrowserInfo>(DEFAULT_BROWSER);

  useEffect(() => {
    setBrowser(detectBrowser());
  }, []);

  return browser;
}

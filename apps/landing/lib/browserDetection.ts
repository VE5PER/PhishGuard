export type BrowserInfo = {
  id: "chrome" | "brave" | "edge" | "opera" | "chromium";
  name: string;
  actionText: string;
  settingsUrl: string;
  storeName: string;
  isMobile: boolean;
  os: "ios" | "android" | "macos" | "windows" | "linux" | "unknown";
};

export function detectBrowser(): BrowserInfo {
  if (typeof window === "undefined") {
    return {
      id: "chrome",
      name: "Google Chrome",
      actionText: "Add to Chrome",
      settingsUrl: "chrome://extensions",
      storeName: "Chrome Web Store",
      isMobile: false,
      os: "unknown",
    };
  }

  const nav = window.navigator as any;
  const ua = nav.userAgent || "";
  const platform = nav.platform || "";

  // Mobile and OS detection
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (platform === "MacIntel" && nav.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi|Tablet/i.test(ua);

  let os: BrowserInfo["os"] = "unknown";
  if (isIOS) os = "ios";
  else if (isAndroid) os = "android";
  else if (/Macintosh|MacIntel|MacPPC|Mac68K/i.test(ua)) os = "macos";
  else if (/Win32|Win64|Windows|WinCE/i.test(ua)) os = "windows";
  else if (/Linux/i.test(ua)) os = "linux";

  const mobileActionText = "Get Desktop Extension";

  if (nav.brave && typeof nav.brave.isBrave === "function") {
    return {
      id: "brave",
      name: "Brave Browser",
      actionText: isMobile ? mobileActionText : "Add to Brave",
      settingsUrl: "brave://extensions",
      storeName: "Chrome Web Store / Brave",
      isMobile,
      os,
    };
  }

  if (ua.includes("Brave")) {
    return {
      id: "brave",
      name: "Brave Browser",
      actionText: isMobile ? mobileActionText : "Add to Brave",
      settingsUrl: "brave://extensions",
      storeName: "Chrome Web Store / Brave",
      isMobile,
      os,
    };
  }

  if (ua.includes("Edg/")) {
    return {
      id: "edge",
      name: "Microsoft Edge",
      actionText: isMobile ? mobileActionText : "Get for Edge",
      settingsUrl: "edge://extensions",
      storeName: "Edge Add-ons",
      isMobile,
      os,
    };
  }

  if (ua.includes("OPR/") || ua.includes("Opera")) {
    return {
      id: "opera",
      name: "Opera Browser",
      actionText: isMobile ? mobileActionText : "Add to Opera",
      settingsUrl: "opera://extensions",
      storeName: "Opera Add-ons",
      isMobile,
      os,
    };
  }

  return {
    id: "chrome",
    name: "Google Chrome",
    actionText: isMobile ? mobileActionText : "Add to Chrome",
    settingsUrl: "chrome://extensions",
    storeName: "Chrome Web Store",
    isMobile,
    os,
  };
}

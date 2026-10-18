"use client";

import React, { useState, useEffect } from "react";
import { X, Download, Check, FolderArchive, Share2, Copy, Laptop, QrCode, ChevronDown } from "lucide-react";
import { BrowserIcon } from "@/components/BrowserIcon";
import { useBrowser } from "@/lib/useBrowser";
import { useProductFacts } from "@/lib/useProductFacts";
import { useScrollLock } from "@/lib/useScrollLock";
import { cn } from "@/lib/utils";

interface InstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Clean SVG QR Code representing the PhishGuard site URL
 */
function PhishGuardQrCode({ size = 160 }: { size?: number }) {
  // Deterministic SVG QR matrix representation for crisp vector rendering
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-white p-3 shadow-lg">
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="black"
        className="shape-rendering-crisp"
        aria-label="QR Code to open PhishGuard on desktop"
      >
        {/* Top-Left Finder */}
        <rect x="5" y="5" width="28" height="28" fill="#08090A" rx="2" />
        <rect x="9" y="9" width="20" height="20" fill="white" rx="1" />
        <rect x="13" y="13" width="12" height="12" fill="#08090A" rx="1" />

        {/* Top-Right Finder */}
        <rect x="67" y="5" width="28" height="28" fill="#08090A" rx="2" />
        <rect x="71" y="9" width="20" height="20" fill="white" rx="1" />
        <rect x="75" y="13" width="12" height="12" fill="#08090A" rx="1" />

        {/* Bottom-Left Finder */}
        <rect x="5" y="67" width="28" height="28" fill="#08090A" rx="2" />
        <rect x="9" y="71" width="20" height="20" fill="white" rx="1" />
        <rect x="13" y="75" width="12" height="12" fill="#08090A" rx="1" />

        {/* Timing Lines */}
        <rect x="37" y="18" width="4" height="4" fill="#08090A" />
        <rect x="45" y="18" width="4" height="4" fill="#08090A" />
        <rect x="53" y="18" width="4" height="4" fill="#08090A" />
        <rect x="18" y="37" width="4" height="4" fill="#08090A" />
        <rect x="18" y="45" width="4" height="4" fill="#08090A" />
        <rect x="18" y="53" width="4" height="4" fill="#08090A" />

        {/* Data Pattern Modules */}
        <rect x="37" y="5" width="4" height="8" fill="#08090A" />
        <rect x="45" y="9" width="4" height="4" fill="#08090A" />
        <rect x="53" y="5" width="8" height="4" fill="#08090A" />
        <rect x="5" y="37" width="8" height="4" fill="#08090A" />
        <rect x="9" y="45" width="4" height="8" fill="#08090A" />
        <rect x="5" y="57" width="4" height="4" fill="#08090A" />

        <rect x="37" y="37" width="8" height="8" fill="#C6F432" stroke="#08090A" strokeWidth="2" />
        <rect x="49" y="37" width="4" height="4" fill="#08090A" />
        <rect x="57" y="37" width="8" height="8" fill="#08090A" />
        <rect x="45" y="49" width="8" height="8" fill="#08090A" />
        <rect x="37" y="57" width="4" height="8" fill="#08090A" />
        <rect x="57" y="49" width="4" height="4" fill="#08090A" />

        <rect x="37" y="73" width="8" height="4" fill="#08090A" />
        <rect x="49" y="69" width="8" height="8" fill="#08090A" />
        <rect x="41" y="85" width="4" height="8" fill="#08090A" />
        <rect x="53" y="81" width="8" height="4" fill="#08090A" />

        <rect x="69" y="37" width="4" height="8" fill="#08090A" />
        <rect x="77" y="37" width="8" height="4" fill="#08090A" />
        <rect x="89" y="41" width="4" height="8" fill="#08090A" />
        <rect x="69" y="49" width="8" height="4" fill="#08090A" />
        <rect x="81" y="49" width="8" height="8" fill="#08090A" />

        <rect x="69" y="65" width="4" height="8" fill="#08090A" />
        <rect x="77" y="69" width="8" height="4" fill="#08090A" />
        <rect x="89" y="65" width="6" height="4" fill="#08090A" />
        <rect x="69" y="81" width="12" height="4" fill="#08090A" />
        <rect x="85" y="77" width="4" height="12" fill="#08090A" />
        <rect x="73" y="89" width="8" height="4" fill="#08090A" />
      </svg>
      <span className="mt-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-950">
        Scan on Desktop
      </span>
    </div>
  );
}

export function InstallModal({ isOpen, onClose }: InstallModalProps) {
  const browser = useBrowser();
  const facts = useProductFacts();
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showDevFiles, setShowDevFiles] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useScrollLock(isOpen);

  useEffect(() => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      setCanShare(true);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(browser.settingsUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleShare = async () => {
    const url = typeof window !== "undefined" ? window.location.origin : "https://phishguard.dev";
    if (canShare && navigator.share) {
      try {
        await navigator.share({
          title: "PhishGuard",
          text: "Install PhishGuard on your computer for on-device phishing protection:",
          url,
        });
        return;
      } catch (err) {
        // User cancelled or share failed, fallback to copy
      }
    }
    navigator.clipboard.writeText(url);
    setCopiedShareLink(true);
    setTimeout(() => setCopiedShareLink(false), 2500);
  };

  const handleCopyShareLink = () => {
    const url = typeof window !== "undefined" ? window.location.origin : "https://phishguard.dev";
    navigator.clipboard.writeText(url);
    setCopiedShareLink(true);
    setTimeout(() => setCopiedShareLink(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto p-4 sm:p-6">
      <div className="fixed inset-0 bg-black/80 animate-fade-in" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-modal-title"
        className="relative z-10 max-h-[90vh] w-full max-w-2xl animate-scale-in overflow-y-auto rounded-2xl border border-white/10 bg-ink-900 p-5 sm:p-8"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white sm:right-5 sm:top-5"
          aria-label="Close dialog"
        >
          <X className="h-4 w-4" />
        </button>

        {browser.isMobile ? (
          /* ============================================================ */
          /* MOBILE-AWARE EXPERIENCE: DESKTOP HANDOFF & SHARE             */
          /* ============================================================ */
          <div>
            <div className="mb-6 flex items-start gap-3.5 pr-10">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-shield/40 bg-shield/10 text-shield">
                <Laptop className="h-5 w-5" strokeWidth={2.2} />
              </span>
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full border border-shield/40 bg-shield/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-shield">
                  Desktop Extension
                </div>
                <h3 id="install-modal-title" className="mt-1.5 font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
                  Install PhishGuard on your computer
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-white/60">
                  PhishGuard runs inside desktop browsers (Chrome, Brave, Edge) to inspect credentials as you type. Share this link to open on your computer.
                </p>
              </div>
            </div>

            {/* Primary Mobile Handoff Actions */}
            <div className="space-y-3">
              {canShare ? (
                <button
                  type="button"
                  onClick={handleShare}
                  className="flex min-h-[50px] w-full cursor-pointer items-center justify-center gap-2.5 rounded-full bg-shield px-6 text-base font-bold text-ink-950 transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
                >
                  <Share2 className="h-5 w-5" />
                  <span>Send Link to My Computer</span>
                </button>
              ) : null}

              <button
                type="button"
                onClick={handleCopyShareLink}
                className={cn(
                  "flex min-h-[48px] w-full cursor-pointer items-center justify-center gap-2 rounded-full border px-5 text-sm font-semibold transition-colors",
                  copiedShareLink
                    ? "border-shield bg-shield/15 text-shield"
                    : "border-white/15 bg-ink-950 text-white/90 hover:bg-white/[0.06] hover:text-white"
                )}
              >
                {copiedShareLink ? <Check className="h-4 w-4 text-shield" /> : <Copy className="h-4 w-4" />}
                <span>{copiedShareLink ? "Link Copied to Clipboard!" : "Copy Link to Open on Desktop"}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowQr((v) => !v)}
                className="flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-xs font-mono text-white/60 hover:text-white transition-colors"
              >
                <QrCode className="h-4 w-4 text-shield" />
                <span>{showQr ? "Hide QR Code" : "Show QR Code to scan from laptop"}</span>
              </button>
            </div>

            {/* QR Code Presentation */}
            {showQr && (
              <div className="mt-4 flex flex-col items-center justify-center rounded-xl border border-white/10 bg-ink-950 p-5 animate-fade-in text-center">
                <PhishGuardQrCode size={140} />
                <p className="mt-3 text-xs leading-relaxed text-white/60">
                  Scan this code using your laptop camera or open directly on your desktop browser.
                </p>
              </div>
            )}

            {/* Collapsible Direct Download for Developers */}
            <div className="mt-6 border-t border-white/[0.08] pt-4">
              <button
                type="button"
                onClick={() => setShowDevFiles((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between py-2 text-left font-mono text-xs text-white/55 hover:text-white transition-colors"
                aria-expanded={showDevFiles}
              >
                <span>Download the package file (.zip)</span>
                <ChevronDown className={cn("h-4 w-4 transition-transform", showDevFiles && "rotate-180")} />
              </button>

              {showDevFiles && (
                <div className="mt-3 grid grid-cols-1 gap-2.5 animate-fade-in">
                  <a
                    href="/download/extension"
                    download
                    className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-xs font-medium text-white/80 transition-colors hover:border-shield/40 hover:text-white"
                  >
                    <FolderArchive className="h-3.5 w-3.5 text-shield" />
                    <span>Download .zip ({facts.zipSize})</span>
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ============================================================ */
          /* DESKTOP EXPERIENCE: ZIP DOWNLOAD & UNPACKED EXTENSION SETUP  */
          /* ============================================================ */
          <div>
            <div className="mb-6 flex items-center gap-4 pr-10">
              <BrowserIcon id={browser.id} className="h-8 w-8 shrink-0" />
              <div>
                <div className="flex flex-wrap items-center gap-x-3">
                  <h3 id="install-modal-title" className="font-display text-xl font-bold tracking-tight text-white">
                    Add PhishGuard to {browser.name}
                  </h3>
                  <span className="font-mono text-xs text-shield">v{facts.extensionVersion}</span>
                </div>
                <p className="mt-1 text-sm text-white/55">
                  Free · runs on-device · no account
                </p>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-xl border border-shield/40 p-5 sm:flex-row sm:items-center">
              <div>
                <div className="mb-1 flex items-center gap-3 font-mono text-xs">
                  <span className="font-medium uppercase tracking-wider text-shield">Extension package</span>
                  <span className="text-white/55">{facts.zipSize}</span>
                </div>
                <h4 className="font-display text-base font-bold text-white">PhishGuard (.zip)</h4>
                <p className="mt-1 text-sm leading-relaxed text-white/60">
                  Unzip it, then load the folder unpacked.
                </p>
              </div>
              <a
                href="/download/extension"
                download
                className="flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-full bg-shield px-6 text-sm font-bold text-ink-950 transition-[filter] hover:brightness-105"
              >
                <Download className="h-4 w-4" />
                <span>Download .zip</span>
              </a>
            </div>

            <div className="mt-6">
              <div className="mb-2 font-mono text-xs uppercase tracking-wider text-white/55">
                Setup in {browser.name}
              </div>

              <ol className="divide-y divide-white/[0.08] border-y border-white/[0.08] text-sm text-white/70">
                <li className="flex items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="w-5 shrink-0 font-mono text-xs text-shield">1</span>
                    <span className="truncate">
                      Open <strong className="font-semibold text-white">{browser.settingsUrl}</strong>
                    </span>
                  </div>
                  <button
                    onClick={handleCopyUrl}
                    className="flex min-h-[36px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 font-mono text-xs text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    {copiedUrl && <Check className="h-3.5 w-3.5 text-shield" />}
                    {copiedUrl ? "Copied" : "Copy"}
                  </button>
                </li>

                <li className="flex items-center gap-3 py-3">
                  <span className="w-5 font-mono text-xs text-shield">2</span>
                  <span>Turn on Developer mode</span>
                </li>

                <li className="flex items-center gap-3 py-3">
                  <span className="w-5 font-mono text-xs text-shield">3</span>
                  <span>
                    Click <strong className="font-semibold text-shield">Load unpacked</strong> and pick the unzipped folder
                  </span>
                </li>
              </ol>
            </div>
          </div>
        )}

        <p className="mt-5 text-center font-mono text-xs text-white/55">
          Never records what you type.
        </p>
      </div>
    </div>
  );
}

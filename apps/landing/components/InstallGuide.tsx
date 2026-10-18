"use client";

import React, { useState, useEffect, useCallback } from "react";
import { FolderArchive, Check, Copy, Shield, ChevronDown } from "lucide-react";
import { BrowserIcon } from "@/components/BrowserIcon";
import { useInstall } from "@/components/InstallProvider";
import { SectionHeader } from "@/components/SectionHeader";
import { useBrowser } from "@/lib/useBrowser";
import { useProductFacts } from "@/lib/useProductFacts";
import { useReveal } from "@/lib/useReveal";
import { cn } from "@/lib/utils";

type BrowserTab = "chrome" | "brave" | "edge";

const BROWSER_TABS: { id: BrowserTab; label: string; settingsUrl: string }[] = [
  { id: "chrome", label: "Chrome", settingsUrl: "chrome://extensions" },
  { id: "brave", label: "Brave", settingsUrl: "brave://extensions" },
  { id: "edge", label: "Edge", settingsUrl: "edge://extensions" },
];

const ASSURANCES = ["No account needed", "No keystrokes recorded", "Runs on-device", "Chrome, Brave & Edge"];

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 2000);
  }, []);

  return { copied, copy };
}

export function InstallGuide() {
  const [activeTab, setActiveTab] = useState<BrowserTab>("chrome");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const browser = useBrowser();
  const facts = useProductFacts();
  const { openInstall } = useInstall();
  const { copied, copy } = useCopy();
  const closingRef = useReveal<HTMLDivElement>();
  const guideRef = useReveal<HTMLDivElement>();

  useEffect(() => {
    if (browser.id === "brave") setActiveTab("brave");
    else if (browser.id === "edge") setActiveTab("edge");
    else setActiveTab("chrome");
  }, [browser.id]);

  const settingsUrl = BROWSER_TABS.find((t) => t.id === activeTab)?.settingsUrl ?? "chrome://extensions";

  const copyButton = (key: string, text: string, label: string) => (
    <button
      onClick={() => copy(key, text)}
      title={label}
      aria-label={label}
      className="flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white"
    >
      {copied === key ? <Check className="h-4 w-4 text-shield" /> : <Copy className="h-4 w-4" />}
    </button>
  );

  return (
    <>
      <section
        id="install"
        data-page
        className="relative isolate flex lg:min-h-[100svh] flex-col justify-center overflow-hidden border-t border-white/[0.08] py-[clamp(4.5rem,7vw,7rem)]"
      >
        <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[900px] max-w-[100vw] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(198,244,50,0.08),transparent)]" />

        <div className="container-x">
          <div ref={closingRef} className="reveal max-w-4xl">
            <p className="eyebrow">Get PhishGuard</p>
            <h2 className="mt-6 font-display text-[clamp(2.75rem,7vw,6.5rem)] font-bold leading-[0.95] tracking-[-0.035em] text-white">
              Protect the next click.
            </h2>
            <p className="mt-8 max-w-2xl text-lg leading-relaxed text-white/65">
              Free, no account, and nothing leaves your device. It covers your bank logins, your critical business workloads, and any AI agent browsing on your behalf.
            </p>

            <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              <button
                onClick={openInstall}
                className="inline-flex h-14 w-full cursor-pointer items-center justify-center gap-3 rounded-full bg-shield px-6 text-base font-bold text-ink-950 transition-[filter,transform] hover:brightness-105 active:scale-[0.98] sm:h-16 sm:w-auto sm:px-8 sm:text-lg"
              >
                <BrowserIcon id={browser.id} className="h-5 w-5" />
                <span>{browser.actionText} &mdash; Free</span>
                <span className="font-mono text-xs font-medium opacity-60">v{facts.extensionVersion}</span>
              </button>

              <div className="flex items-center justify-center gap-6 sm:justify-start">
                <a
                  href="/download/extension"
                  download
                  title="Download .zip"
                  className="inline-flex items-center gap-2 text-base font-medium text-white/70 transition-colors hover:text-white"
                >
                  <FolderArchive className="h-4 w-4" />
                  <span>Download .zip</span>
                </a>
              </div>
            </div>

            <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:flex lg:flex-wrap">
              {ASSURANCES.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-white/70">
                  <Check className="h-4 w-4 shrink-0 text-shield" strokeWidth={2.5} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section
        id="manual-install"
        data-page
        className="relative isolate flex lg:min-h-[100svh] flex-col justify-center overflow-hidden border-t border-white/[0.08] py-[clamp(4rem,6vw,6rem)]"
      >
        <div className="container-x">
          <SectionHeader
            label="Manual install"
            title="Install in a few steps"
            lead="Install directly in developer mode. Download the .zip, unzip it and load it unpacked."
            className="mb-10"
          />

        <div ref={guideRef} className="reveal">
          <div className="flex items-center gap-4 border-b border-white/[0.08] pb-8">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-shield/60 text-shield">
              <Shield className="h-5 w-5" strokeWidth={2.2} />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-x-3">
                <span className="font-display text-lg font-bold text-white">PhishGuard for {browser.name}</span>
                <span className="font-mono text-xs text-shield">v{facts.extensionVersion}</span>
              </div>
              <p className="mt-0.5 text-sm text-white/55">
                Extension package · {facts.zipSize}
              </p>
            </div>
          </div>

          {browser.isMobile && (
            <div className="mt-5 rounded-xl border border-shield/30 bg-shield/[0.06] p-4 text-xs leading-relaxed text-white/80">
              <strong className="text-shield font-semibold">Note for mobile visitors:</strong> PhishGuard is built for desktop Chromium browsers (Chrome, Brave, Edge). Follow these steps when you're on your computer, or tap{" "}
              <button onClick={openInstall} className="text-shield underline font-semibold cursor-pointer">
                Send Link to Desktop
              </button>{" "}
              to open on your computer with 1 tap.
            </div>
          )}

          <div className="mt-8 flex justify-center sm:justify-end">
            <div role="tablist" aria-label="Browser" className="grid w-full grid-cols-3 gap-1 rounded-xl border border-white/10 bg-ink-900 p-1 sm:w-auto sm:inline-flex">
              {BROWSER_TABS.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg px-3 font-mono text-xs transition-colors",
                    activeTab === tab.id ? "bg-ink-700 text-white shadow-sm ring-1 ring-white/15" : "text-white/50 hover:text-white"
                  )}
                >
                  <BrowserIcon id={tab.id} className="h-3.5 w-3.5 shrink-0" />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          <ol className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-white/[0.08]">
            <li className="md:pr-8">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-4xl font-medium text-shield">01</span>
                
              </div>
              <h4 className="mt-4 font-display text-lg font-bold text-white">Open extensions</h4>
              <p className="mt-2 text-base leading-relaxed text-white/60">
                Paste this into a new tab:
              </p>
              <div className="mt-4 flex items-center justify-between gap-2 border-y border-white/[0.08] py-1 pl-1 font-mono text-sm">
                <span className="truncate text-white">{settingsUrl}</span>
                {copyButton("settings-url", settingsUrl, "Copy URL")}
              </div>
            </li>

            <li className="md:px-8">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-4xl font-medium text-shield">02</span>
                
              </div>
              <h4 className="mt-4 font-display text-lg font-bold text-white">Turn on Developer mode</h4>
              <p className="mt-2 text-base leading-relaxed text-white/60">
                It's the toggle in the top-right corner of that page.
              </p>
            </li>

            <li className="md:pl-8">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-4xl font-medium text-shield">03</span>
                
              </div>
              <h4 className="mt-4 font-display text-lg font-bold text-white">Load it</h4>
              <p className="mt-2 text-base leading-relaxed text-white/60">
                Unzip the <strong className="font-semibold text-shield">.zip</strong>, click Load unpacked and pick the folder.
              </p>
            </li>
          </ol>

          <div className="mt-14 border-t border-white/[0.08]">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
              className="flex w-full cursor-pointer flex-col items-start justify-between gap-2 py-5 text-left font-mono text-xs text-white/70 transition-colors hover:text-white sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="font-medium uppercase tracking-wider">
                Checksums &amp; enterprise deployment
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-white/50">
                <span>{showAdvanced ? "Hide" : "Show"}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")} />
              </span>
            </button>

            {showAdvanced && (
              <div className="animate-fade-in divide-y divide-white/[0.08] border-t border-white/[0.08] font-mono text-xs">
                <div className="py-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium uppercase tracking-wider text-white/55">.zip SHA-256</span>
                    {copyButton("zip-hash", facts.zipSha256, "Copy ZIP SHA-256")}
                  </div>
                  <div className="mt-1 select-all break-all text-white/80">{facts.zipSha256}</div>
                </div>

                <div className="flex flex-col items-start justify-between gap-4 py-4 sm:flex-row sm:items-center">
                  <div>
                    <div className="font-medium text-white">Extension ID</div>
                    <div className="mt-1 break-all text-white/55">{facts.extensionId}</div>
                  </div>
                  <button
                    onClick={() => copy("ext-id", facts.extensionId)}
                    className="flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 px-3.5 text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    {copied === "ext-id" ? <Check className="h-3.5 w-3.5 text-shield" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>Copy ID</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
    </>
  );
}

"use client";

import React from "react";
import { Download } from "lucide-react";
import { BrowserIcon } from "@/components/BrowserIcon";
import { HeroCanvas } from "@/components/HeroCanvas";
import { MLModelRadar, ScreenRadarOverlay } from "@/components/MLModelRadar";
import { useInstall } from "@/components/InstallProvider";
import { useBrowser } from "@/lib/useBrowser";
import { useProductFacts } from "@/lib/useProductFacts";
import { cn } from "@/lib/utils";

const delay = (ms: number): React.CSSProperties => ({ animationDelay: `${ms}ms` });

const H1_CLASS =
  "font-display text-[clamp(2.25rem,min(8.5vw,13svh),9.5rem)] font-bold leading-[0.98] sm:leading-[0.9] tracking-[-0.045em] text-white";

function Headline() {
  return (
    <>
      <span className="block animate-fade-up" style={delay(80)}>
        Phishing stops here<span className="text-shield">.</span>
      </span>
      <span
        className="mt-[0.25em] block animate-fade-up text-[0.44em] font-medium leading-[1.15] tracking-[-0.02em] text-white/70"
        style={delay(180)}
      >
        For humans and <span className="text-shield">AI agents</span>.
      </span>
    </>
  );
}

function HeroCopy() {
  return (
    <div className="max-w-2xl space-y-3 sm:space-y-4">
      <p className="text-base leading-relaxed text-white/80 sm:text-lg lg:text-xl">
        People fall for pixel-perfect bank clones. AI agents walk straight into invisible click traps. PhishGuard spots both&mdash;<span className="text-white">on your device</span>&mdash;and neutralizes the threat before a credential leaves.
      </p>
      <p className="text-sm leading-relaxed text-white/55 sm:text-base">
        No keystrokes recorded. No screenshots saved. Runs locally on your GPU, with a WASM fallback for older machines.
      </p>
    </div>
  );
}

function HeroActions() {
  const browser = useBrowser();
  const facts = useProductFacts();
  const { openInstall } = useInstall();

  return (
    <div className="flex flex-col gap-3 lg:items-end">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-6">
        <button
          onClick={openInstall}
          className="inline-flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-3 rounded-full bg-shield px-6 text-base font-bold text-ink-950 transition-[filter,transform] hover:brightness-105 active:scale-[0.98] sm:h-14 sm:w-auto sm:px-7"
        >
          <BrowserIcon id={browser.id} className="h-5 w-5" />
          <span>{browser.actionText} &mdash; Free</span>
          <span className="font-mono text-xs font-medium opacity-60">v{facts.extensionVersion}</span>
        </button>

        <a
          href="/download/extension"
          download
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 text-sm font-medium text-white/70 transition-colors hover:text-white sm:h-12 sm:w-auto sm:text-base"
        >
          <Download className="h-4 w-4" />
          <span>Download .zip</span>
        </a>
      </div>
      <p className="text-center font-mono text-[12px] sm:text-[13px] text-white/55 sm:text-left">
        {browser.isMobile
          ? "Desktop extension for Chrome, Brave, Edge & Opera"
          : "Works in Chrome, Brave, Edge and any Chromium browser"}
      </p>
    </div>
  );
}

const LEGIBILITY_OVERLAY =
  "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_55%,rgba(8,9,10,0.88),rgba(8,9,10,0.45)_55%,rgba(8,9,10,0.15))]";

export function Hero() {
  return (
    <section id="top" data-page className="relative isolate flex min-h-[100svh] flex-col overflow-hidden">
      {/* 1. Base Kinematic Telemetry Trails Canvas (HeroCanvas) */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <HeroCanvas className="h-full w-full" />
      </div>

      {/* 2. Legibility Vignette */}
      <div className={cn("pointer-events-none absolute inset-0 z-[1]", LEGIBILITY_OVERLAY)} />

      {/* 3. Screen Radar Overlay: dynamic 360° radar sweep & detection blips */}
      <ScreenRadarOverlay className="pointer-events-none absolute inset-0 z-[2]" />

      {/* 4. Bottom fade into next section */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-40 bg-gradient-to-t from-ink-950 to-transparent" />

      <div className="container-x relative z-10 flex flex-1 flex-col justify-center gap-6 sm:gap-8 pb-12 pt-20 sm:pb-16 sm:pt-28 lg:justify-between lg:gap-0 lg:pb-12">
        <div className="relative z-10">
          <p className="eyebrow animate-fade-up" style={delay(0)}>
            On-device phishing & fraud defense
          </p>
          <h1 className={cn("mt-4 sm:mt-6", H1_CLASS)}>
            <Headline />
          </h1>
        </div>

        {/* Model Entity: Clean layout slotting on both mobile and desktop */}
        <div
          className="relative my-2 flex justify-center py-1 sm:my-3 lg:my-0 animate-fade-up z-10"
          style={delay(200)}
        >
          <MLModelRadar />
        </div>

        <div className="relative z-10 grid grid-cols-1 items-end gap-6 lg:grid-cols-12 lg:gap-8">
          <div className="animate-fade-up lg:col-span-6" style={delay(240)}>
            <HeroCopy />
          </div>
          <div className="animate-fade-up lg:col-span-5 lg:col-start-8" style={delay(320)}>
            <HeroActions />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-3 lg:flex">
        <span className="font-mono text-xs uppercase tracking-[0.14em] text-white/55">Scroll</span>
        <span className="relative block h-10 w-px overflow-hidden bg-white/15">
          <span className="absolute inset-x-0 top-0 block h-4 animate-scroll-cue bg-shield" />
        </span>
      </div>
    </section>
  );
}

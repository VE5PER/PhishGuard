"use client";

import React, { useState } from "react";
import { Check, X, AlertTriangle } from "lucide-react";
import { SectionHeader } from "@/components/SectionHeader";
import { cn } from "@/lib/utils";

type Status = "yes" | "warn" | "no";

interface Verdict {
  status: Status;
  text: string;
}

interface Feature {
  name: string;
  sub: string;
  chrome: Verdict;
  av: Verdict;
  phishguard: Verdict;
}

const FEATURES: Feature[] = [
  {
    name: "Brand-new phishing domains",
    sub: "Fake bank logins registered minutes before the attack",
    chrome: { status: "warn", text: "Mostly list-based" },
    av: { status: "warn", text: "Delayed signatures" },
    phishguard: { status: "yes", text: "Caught on first visit" },
  },
  {
    name: "AI agents & rogue extensions",
    sub: "Scripts typing credentials into traps",
    chrome: { status: "no", text: "Doesn't watch in-page actions" },
    av: { status: "no", text: "Can't see inside the browser" },
    phishguard: { status: "yes", text: "Detects robotic input, halts submission" },
  },
  {
    name: "Invisible click traps",
    sub: "Hidden overlays and clickjacking",
    chrome: { status: "no", text: "Not inspected" },
    av: { status: "no", text: "Not inspected" },
    phishguard: { status: "yes", text: "Detected as the page changes" },
  },
  {
    name: "Browsing privacy",
    sub: "Who learns which sites you visit",
    chrome: { status: "warn", text: "Checks URLs with Google" },
    av: { status: "no", text: "Often uploads telemetry" },
    phishguard: { status: "yes", text: "No one—stays on your device" },
  },
  {
    name: "Keystroke privacy",
    sub: "What happens to what you type",
    chrome: { status: "warn", text: "Standard browser handling" },
    av: { status: "warn", text: "Varies by vendor" },
    phishguard: { status: "yes", text: "Timing only, never characters" },
  },
  {
    name: "Page analysis",
    sub: "How the verdict is produced",
    chrome: { status: "warn", text: "Network round-trip" },
    av: { status: "warn", text: "Background scanning load" },
    phishguard: { status: "yes", text: "On-device, in your browser" },
  },
];

const MARKERS: Record<Status, { Icon: React.ElementType; tone: string }> = {
  yes: { Icon: Check, tone: "text-shield" },
  warn: { Icon: AlertTriangle, tone: "text-alert" },
  no: { Icon: X, tone: "text-quarantine" },
};

function Verdict({ status, text, strong = false }: Verdict & { strong?: boolean }) {
  const { Icon, tone } = MARKERS[status];
  return (
    <div className="flex items-start gap-2.5">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} strokeWidth={2.5} />
      <span className={cn("text-sm leading-snug", strong ? "font-medium text-white" : "text-white/50")}>{text}</span>
    </div>
  );
}

export function Comparison() {
  const [competitor, setCompetitor] = useState<"chrome" | "av" | "all">("chrome");

  return (
    <section
      id="comparison"
      data-page
      className="relative overflow-hidden border-t lg:flex lg:min-h-[100svh] lg:flex-col lg:justify-center border-white/[0.08] py-[clamp(6rem,10vw,10rem)]"
    >
      <div className="container-x">
        <SectionHeader
          label="Compare"
          title="Blocklists are always one site behind."
          lead="Safe Browsing and antivirus wait for a site to be reported. PhishGuard judges the page itself, the moment it loads."
          className="mb-8 lg:mb-16"
        />

        {/* Mobile-Only Competitor Segmented Switcher */}
        <div className="mb-6 block md:hidden">
          <div
            role="tablist"
            aria-label="Compare against"
            className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-ink-900 p-1 font-mono text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={competitor === "chrome"}
              onClick={() => setCompetitor("chrome")}
              className={cn(
                "flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-2 font-semibold transition-all text-[11px] sm:text-xs",
                competitor === "chrome" ? "bg-ink-700 text-white shadow-sm ring-1 ring-white/15" : "text-white/55 hover:text-white"
              )}
            >
              vs Chrome
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={competitor === "av"}
              onClick={() => setCompetitor("av")}
              className={cn(
                "flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-2 font-semibold transition-all text-[11px] sm:text-xs",
                competitor === "av" ? "bg-ink-700 text-white shadow-sm ring-1 ring-white/15" : "text-white/55 hover:text-white"
              )}
            >
              vs Antivirus
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={competitor === "all"}
              onClick={() => setCompetitor("all")}
              className={cn(
                "flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-2 font-semibold transition-all text-[11px] sm:text-xs",
                competitor === "all" ? "bg-ink-700 text-white shadow-sm ring-1 ring-white/15" : "text-white/55 hover:text-white"
              )}
            >
              Show All
            </button>
          </div>
        </div>

        {/* Mobile Comparison Cards */}
        <div className="space-y-4 md:hidden">
          {FEATURES.map((item) => (
            <div key={item.name} className="rounded-xl border border-white/[0.08] bg-ink-900/50 p-4 space-y-3">
              <div>
                <h3 className="font-display text-base font-bold text-white">{item.name}</h3>
                <p className="mt-0.5 font-mono text-[11px] text-white/55">{item.sub}</p>
              </div>

              {/* PhishGuard Advantage Card */}
              <div className="rounded-lg border border-shield/40 bg-shield/[0.08] p-3">
                <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-shield">PhishGuard</div>
                <Verdict {...item.phishguard} strong />
              </div>

              {/* Competitor Card(s) */}
              {(competitor === "chrome" || competitor === "all") && (
                <div className="rounded-lg border border-white/[0.06] bg-ink-950/70 p-3">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/50">
                    Chrome Safe Browsing
                  </span>
                  <Verdict {...item.chrome} />
                </div>
              )}

              {(competitor === "av" || competitor === "all") && (
                <div className="rounded-lg border border-white/[0.06] bg-ink-950/70 p-3">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/50">
                    Traditional Antivirus
                  </span>
                  <Verdict {...item.av} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] border-collapse text-left font-body">
            <thead>
              <tr className="border-b border-white/[0.12] font-mono text-xs uppercase tracking-wider text-white/55">
                <th className="w-[30%] px-5 py-4 font-medium">Capability</th>
                <th className="w-[26%] bg-shield/[0.06] px-5 py-4 font-medium text-shield">PhishGuard</th>
                <th className="w-[22%] px-5 py-4 font-medium">Chrome Safe Browsing</th>
                <th className="w-[22%] px-5 py-4 font-medium">Antivirus</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.08]">
              {FEATURES.map((item) => (
                <tr key={item.name}>
                  <td className="px-5 py-6 align-top">
                    <div className="text-base font-semibold text-white">{item.name}</div>
                    <div className="mt-1 font-mono text-xs text-white/55">{item.sub}</div>
                  </td>
                  <td className="bg-shield/[0.06] px-5 py-6 align-top">
                    <Verdict {...item.phishguard} strong />
                  </td>
                  <td className="px-5 py-6 align-top">
                    <Verdict {...item.chrome} />
                  </td>
                  <td className="px-5 py-6 align-top">
                    <Verdict {...item.av} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

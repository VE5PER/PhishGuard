"use client";

import React, { useState } from "react";
import { Cpu, EyeOff, GitFork, ScanEye, CloudLightning, Lock, ChevronDown } from "lucide-react";
import { fmtKB, type ProductFacts } from "@/lib/facts";
import { useProductFacts } from "@/lib/useProductFacts";
import { cn } from "@/lib/utils";

interface TelemetrySpec {
  label: string;
  value: string;
  highlight?: boolean;
}

interface DefensePillar {
  id: string;
  categoryLabel: string;
  icon: React.ElementType;
  title: string;
  description: string;
  specs: TelemetrySpec[];
  deepArchitectureNote: string;
}

const getPillars = (facts: ProductFacts): DefensePillar[] => [
  {
    id: "neural-shield",
    categoryLabel: "ON-DEVICE ENGINE",
    icon: Cpu,
    title: "Runs on your GPU",
    description:
      `A ${fmtKB(facts.modelSizeBytes)} model reads cursor motion, page structure and a ${facts.visionInput} glance at the page directly on your device—no round-trip to any server.`,
    specs: [
      { label: "Inference", value: "On-device", highlight: true },
      { label: "Size", value: fmtKB(facts.modelSizeBytes) },
      { label: "Runtime", value: "WebGPU, WASM fallback" },
      { label: "Model", value: "1D-CNN + BiLSTM + vision trunk" },
    ],
    deepArchitectureNote:
      "PyTorch weights are distilled and quantized into an INT8 ONNX model, then run in the browser with WebGPU—or WASM SIMD on older hardware. No inference traffic leaves the device.",
  },
  {
    id: "telemetry-vault",
    categoryLabel: "PRIVACY",
    icon: EyeOff,
    title: "Never sees what you type",
    description:
      `Only the timing between keys is measured, never the keys themselves. Passwords and form values can't be recorded—by design. Screenshots shrink to ${facts.visionInput} in memory and are discarded.`,
    specs: [
      { label: "Characters stored", value: "0", highlight: true },
      { label: "Measured", value: "Key timing, cursor motion" },
      { label: "Enforced by", value: "Strict schemas" },
    ],
    deepArchitectureNote:
      "Telemetry contracts are defined twice—Zod in TypeScript, Pydantic v2 in Python—both with extra fields forbidden. A payload that tries to carry typed text is rejected before it is processed.",
  },
  {
    id: "tri-state-triage",
    categoryLabel: "TRIAGE",
    icon: GitFork,
    title: "Quiet until it matters",
    description:
      "Safe pages pass silently. Suspicious ones get flagged in the toolbar. Dangerous ones are neutralized on the spot.",
    specs: [
      { label: "Safe", value: "Silent, no network", highlight: true },
      { label: "Suspicious", value: "Flagged, optional cloud check" },
      { label: "Dangerous", value: "Full-screen block" },
    ],
    deepArchitectureNote:
      "Most browsing never triggers a warning or a network request. Cloud verification only runs when you ask for it from the toolbar.",
  },
  {
    id: "dom-radar",
    categoryLabel: "PAGE STRUCTURE",
    icon: ScanEye,
    title: "Finds the traps you can't see",
    description:
      "Invisible overlays, hidden inputs, cross-origin frames and look-alike login forms—spotted as the page changes.",
    specs: [
      { label: "Overlays", value: "opacity: 0 detection", highlight: true },
      { label: "Frames", value: "Cross-origin checks" },
      { label: "Updates", value: "Live, as the page changes" },
    ],
    deepArchitectureNote:
      "A MutationObserver re-inspects computed styles whenever the DOM changes, so traps injected after load are caught too.",
  },
  {
    id: "cloud-teacher",
    categoryLabel: "CLOUD · OPT-IN",
    icon: CloudLightning,
    title: "A second opinion, only if you ask",
    description:
      "For borderline pages, you can request a deeper check from a larger cloud model that compares the page's look against known brands.",
    specs: [
      { label: "Triggered by", value: "You, from the toolbar", highlight: true },
      { label: "Checks", value: "Layout & logo match" },
      { label: "Sends", value: "URL + timing; a screenshot only if you tick the box" },
    ],
    deepArchitectureNote:
      "The gateway compares a consented screenshot against reference login pages for major brands using a compact vision model (MobileNetV3), alongside a larger behavioral teacher, and updates a shared domain-reputation cache.",
  },
  {
    id: "crypto-integrity",
    categoryLabel: "INTEGRITY",
    icon: Lock,
    title: "Tamper-checked updates",
    description:
      "Every model update is verified against its SHA-256 hash before it runs.",
    specs: [
      { label: "Check", value: "SHA-256 before load", highlight: true },
      { label: "Storage", value: "Local, in-browser" },
      { label: "Package", value: ".zip, fixed extension ID" },
    ],
    deepArchitectureNote:
      "Model binaries and update manifests are verified locally before they are loaded into memory, so a tampered or swapped model is refused.",
  },
];

const MAX_SPECS = 2;

export function Benefits() {
  const facts = useProductFacts();
  const pillars = getPillars(facts);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section
      id="features"
      data-page
      className="relative flex flex-col overflow-x-clip border-t border-white/[0.08] py-[clamp(5rem,8vw,7rem)] lg:h-[100svh] lg:min-h-[640px] lg:pb-8 lg:pt-20"
    >
      <div className="container-x flex min-h-0 flex-1 flex-col">
        <div className="mb-8 grid grid-cols-1 gap-4 lg:mb-5 lg:grid-cols-12 lg:items-end lg:gap-x-8">
          <div className="lg:col-span-7">
            <p className="eyebrow">Under the hood</p>
            <h2 className="mt-3 font-display text-[clamp(1.75rem,min(3.4vw,5.2svh),2.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-white">
              Built to stay on your device.
            </h2>
          </div>
          <p className="text-base leading-relaxed text-white/60 lg:col-span-5">
            Six design decisions that keep PhishGuard&apos;s fraud detection fast, private and hard to tamper with.
          </p>
        </div>

        <ol className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 lg:flex-1 lg:grid-cols-3 lg:grid-rows-2">
          {pillars.map((pillar) => {
            const Icon = pillar.icon;
            const expanded = expandedId === pillar.id;
            const noteId = `${pillar.id}-note`;

            return (
              <li
                key={pillar.id}
                className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-ink-900 p-4 lg:p-5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-white/55">{pillar.categoryLabel}</span>
                  <Icon className="h-4 w-4 shrink-0 text-shield" strokeWidth={2} />
                </div>

                <h3 className="mt-2 font-display text-[20px] font-bold leading-tight tracking-tight text-white">{pillar.title}</h3>

                <div className="mt-2 grid min-h-0 flex-1">
                  <div
                    className={cn(
                      "col-start-1 row-start-1 min-h-0 overflow-hidden transition-opacity duration-200",
                      expanded ? "pointer-events-none opacity-0" : "opacity-100"
                    )}
                    aria-hidden={expanded}
                  >
                    <p className="line-clamp-3 text-sm leading-relaxed text-white/65">{pillar.description}</p>
                    <dl className="mt-3 space-y-1.5 border-t border-white/[0.08] pt-3 font-mono">
                      {pillar.specs.slice(0, MAX_SPECS).map((spec) => (
                        <div key={spec.label} className="flex items-baseline justify-between gap-3 text-[11px]">
                          <dt className="shrink-0 uppercase tracking-wider text-white/55">{spec.label}</dt>
                          <dd className={cn("truncate text-right", spec.highlight ? "text-white" : "text-white/70")}>{spec.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  <div
                    id={noteId}
                    className={cn(
                      "col-start-1 row-start-1 min-h-0 overflow-hidden rounded-lg bg-ink-950 p-3 text-[13px] leading-relaxed text-white/70 transition-opacity duration-200",
                      expanded ? "opacity-100" : "pointer-events-none opacity-0"
                    )}
                    aria-hidden={!expanded}
                  >
                    {pillar.deepArchitectureNote}
                  </div>
                </div>

                <button
                  onClick={() => setExpandedId(expanded ? null : pillar.id)}
                  aria-expanded={expanded}
                  aria-controls={noteId}
                  className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-1.5 font-mono text-xs text-white/55 transition-colors hover:text-white"
                >
                  <span>{expanded ? "Back" : "Technical details"}</span>
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

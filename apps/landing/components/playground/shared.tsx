import React from "react";
import { cn } from "@/lib/utils";

export type Tone = "shield" | "alert" | "quarantine" | "neutral";

export function toneFor(value: string | null | undefined): Tone {
  switch (value) {
    case "SAFE":
    case "ALLOW":
    case "ok":
      return "shield";
    case "AMBIGUOUS":
    case "WARN":
    case "fallback":
    case "unconfigured":
    case "circuit_open":
    case "budget_exhausted":
      return "alert";
    case "BLOCK":
      return "quarantine";
    default:
      return "neutral";
  }
}

const TONE_CLASSES: Record<Tone, string> = {
  shield: "border-shield/50 bg-shield/10 text-shield",
  alert: "border-alert/50 bg-alert/10 text-alert",
  quarantine: "border-quarantine/50 bg-quarantine/10 text-quarantine",
  neutral: "border-white/[0.14] bg-white/[0.04] text-white/70",
};

export function Badge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">{label}</p>
      <p className="mt-1 break-words font-mono text-lg text-white">{value}</p>
      {hint ? <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/35">{hint}</p> : null}
    </div>
  );
}

export function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-white/[0.08] bg-ink-900 p-5", className)}>
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/55">{title}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function RiskMeter({ score }: { score: number }) {
  const percent = Math.min(Math.max(score, 0), 1) * 100;
  return (
    <div className="relative mt-3 h-2 rounded-full bg-white/[0.08]" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={score}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-out",
          score > 0.85 ? "bg-quarantine" : score >= 0.15 ? "bg-alert" : "bg-shield",
        )}
        style={{ width: `${percent}%` }}
      />
      {[15, 85].map((mark) => (
        <span key={mark} className="absolute top-[-4px] h-4 w-px bg-white/50" style={{ left: `${mark}%` }}>
          <span className="absolute left-1/2 top-5 -translate-x-1/2 font-mono text-[10px] text-white/45">0.{mark}</span>
        </span>
      ))}
    </div>
  );
}

export function formatScore(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

export function formatMs(value: number | null): string {
  if (value === null) return "n/a";
  return value < 10 ? `${value.toFixed(2)} ms` : `${value.toFixed(0)} ms`;
}

const BRAND_NAMES: Record<string, string> = { paypal: "PayPal", google: "Google" };

export function displayBrand(name: string | null | undefined): string | null {
  if (!name) return null;
  return BRAND_NAMES[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

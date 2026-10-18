import React from "react";
import { cn } from "@/lib/utils";

const STAGGER_MS = 90;

export function StatsStrip({ baseDelayMs = 0 }: { baseDelayMs?: number }) {
  const stats = [
    { value: "AI", unit: "", title: "On-device analysis", sub: "Runs in your browser" },
    { value: "0", unit: "keys", title: "Keystrokes recorded", sub: "Timing only, never characters" },
    { value: "100", unit: "%", title: "Local by default", sub: "Nothing leaves unless you ask" },
    { value: "3", unit: "signals", title: "Interaction, page, vision", sub: "Fused into one risk score" },
  ];

  return (
    <dl className="grid grid-cols-2 border-y border-white/[0.08] lg:grid-cols-4">
      {stats.map((stat, i) => (
        <div
          key={stat.title}
          data-anim
          style={{ "--d": `${baseDelayMs + i * STAGGER_MS}ms` } as React.CSSProperties}
          className={cn(
            "border-white/[0.08] px-0 py-8 sm:py-10",
            i % 2 === 1 && "border-l pl-5 sm:pl-8",
            i % 2 === 0 && "pr-5 sm:pr-8",
            i >= 2 && "border-t lg:border-t-0",
            i > 0 && "lg:border-l lg:pl-8",
            i < 3 && "lg:pr-8"
          )}
        >
          <dd className="flex items-baseline gap-1.5 font-display text-[clamp(2.5rem,5vw,4.5rem)] font-bold leading-none tracking-tight text-white">
            <span>{stat.value}</span>
            {stat.unit && <span className="font-mono text-sm font-medium text-shield">{stat.unit}</span>}
          </dd>
          <dt className="mt-3 text-sm font-semibold text-white/85 sm:mt-4">{stat.title}</dt>
          <dd className="mt-1 font-mono text-xs text-white/55">{stat.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

"use client";

import React, { useMemo, useState } from "react";
import type { PlaygroundRunResponse, PlaygroundScenario } from "@phishguard/types";

type ScenarioPayload = PlaygroundScenario["payload"];
import { cn } from "@/lib/utils";

const TABS = ["Kinematics", "Gemini trace", "Raw JSON"] as const;
type Tab = (typeof TABS)[number];

const SCREENSHOT_PREVIEW_CHARS = 80;

function truncateScreenshot<T extends { screenshotBase64?: string | null }>(payload: T): T {
  const value = payload.screenshotBase64;
  if (!value || value.length <= SCREENSHOT_PREVIEW_CHARS) return payload;
  return { ...payload, screenshotBase64: `${value.slice(0, SCREENSHOT_PREVIEW_CHARS)}… (${value.length} chars)` };
}

function Kinematics({ payload, label }: { payload: ScenarioPayload; label: string }) {
  const points = payload.mouseTrajectorySeries;
  const geometry = useMemo(() => {
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${(p.x * 1024).toFixed(1)},${(p.y * 640).toFixed(1)}`).join(" ");
    const maxV = Math.max(...points.map((p) => p.velocity), 1e-9);
    const t0 = points[0]?.timestamp ?? 0;
    const span = Math.max((points[points.length - 1]?.timestamp ?? 0) - t0, 1e-9);
    const spark = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${(((p.timestamp - t0) / span) * 300).toFixed(1)},${(58 - (p.velocity / maxV) * 54).toFixed(1)}`)
      .join(" ");
    return { path, spark, maxV, span };
  }, [points]);
  if (points.length === 0) return <p className="text-sm text-white/50">No pointer samples in this scenario.</p>;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">Pointer path ({points.length} samples, {label})</p>
        <svg viewBox="0 0 1024 640" className="w-full rounded-lg border border-white/[0.08] bg-ink-950" role="img" aria-label="Pointer path">
          <path d={geometry.path} fill="none" stroke="#C6F432" strokeWidth={3} strokeLinejoin="round" />
        </svg>
      </div>
      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">
          Velocity over {geometry.span.toFixed(0)} ms (peak {geometry.maxV.toFixed(5)} /ms)
        </p>
        <svg viewBox="0 0 300 62" className="w-full rounded-lg border border-white/[0.08] bg-ink-950" role="img" aria-label="Velocity sparkline">
          <path d={geometry.spark} fill="none" stroke="#FFB224" strokeWidth={1.5} />
        </svg>
      </div>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border border-white/[0.08] bg-ink-950 p-4 font-mono text-xs leading-relaxed text-white/75">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function InspectTabs({ payload, label, run }: { payload: ScenarioPayload; label: string; run: PlaygroundRunResponse | null }) {
  const [tab, setTab] = useState<Tab>("Kinematics");
  const toolCalls = run?.gemini.trace.toolCalls ?? [];
  return (
    <div className="mt-10 rounded-2xl border border-white/[0.08] bg-ink-900 p-5">
      <div role="tablist" aria-label="Inspect" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "min-h-[40px] shrink-0 rounded-full border px-4 font-mono text-xs uppercase tracking-[0.08em] transition-colors",
              tab === name ? "border-shield/60 bg-shield/10 text-shield" : "border-white/[0.12] text-white/60 hover:text-white",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="mt-5" role="tabpanel">
        {tab === "Kinematics" && <Kinematics payload={payload} label={label} />}
        {tab === "Gemini trace" &&
          (!run ? (
            <p className="text-sm text-white/50">Escalate to the cloud to see the Gemini agent&apos;s tool calls.</p>
          ) : toolCalls.length === 0 ? (
            <p className="text-sm text-white/60">No tool calls{run.gemini.cached ? " (cached verdict)" : ""}.</p>
          ) : (
            <ol className="space-y-4">
              {toolCalls.map((call, index) => (
                <li key={index} className="rounded-lg border border-white/[0.08] p-4">
                  <p className="font-mono text-sm text-shield">{call.name}</p>
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">args</p>
                  <Json value={call.args} />
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">result</p>
                  <Json value={call.result} />
                </li>
              ))}
            </ol>
          ))}
        {tab === "Raw JSON" && (
          <Json
            value={
              run
                ? {
                    payload: truncateScreenshot(run.payload),
                    evidenceVerdict: run.evidence.verdict,
                    geminiVerdict: run.gemini.verdict,
                    geminiTrace: run.gemini.trace,
                  }
                : { scenarioPayload: truncateScreenshot(payload) }
            }
          />
        )}
      </div>
    </div>
  );
}

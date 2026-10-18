import React from "react";
import { Check } from "lucide-react";
import type { PlaygroundRunResponse, TeacherToolCall } from "@phishguard/types";

export interface TimelineStep {
  id: string;
  text: string;
  detail?: string;
  delayMs: number;
  reveals?: "evidence" | "gemini";
}

function firstArgValue(call: TeacherToolCall): string {
  const first = Object.values(call.args)[0];
  return typeof first === "string" ? first : JSON.stringify(first ?? "");
}

function summarizeToolResult(call: TeacherToolCall): string {
  const result = call.result;
  if (call.name === "verify_brand_official_domain") return `authorized: ${result.page_host_authorized ? "yes" : "no"}`;
  if (call.name === "lookup_threat_memory_bank") return `${Number(result.prior_escalations ?? 0)} prior escalations`;
  return "result received";
}

export function buildTimelineSteps(run: PlaygroundRunResponse): TimelineStep[] {
  const { payload, evidence, gemini } = run;
  const parts = [
    `${payload.mouseTrajectorySeries.length} pointer samples`,
    `${payload.keystrokesSummary.length} keystroke timings`,
    `${payload.domElementsSummary.length} DOM findings`,
  ];
  if (payload.screenshotBase64) parts.push("screenshot");
  const calls = gemini.trace.toolCalls;
  const spacing = gemini.latencyMs / (calls.length + 1);
  return [
    { id: "package", text: `Packaging EscalationPayload — ${parts.join(" · ")}`, delayMs: 300 },
    { id: "post", text: "POST /v1/escalate → Cloud Run gateway (asia-south1)", delayMs: 350 },
    {
      id: "evidence",
      text: `Evidence policy v2 → ${evidence.verdict.actionOverride} (${evidence.verdict.confidence.toFixed(2)})`,
      delayMs: 400,
      reveals: "evidence",
    },
    ...calls.map((call, index) => ({
      id: `tool-${index}`,
      text: `Gemini agent → ${call.name}(${firstArgValue(call)})`,
      detail: summarizeToolResult(call),
      delayMs: spacing,
    })),
    {
      id: "rails",
      text: `Safety rails applied → final ${gemini.verdict.actionOverride}`,
      delayMs: spacing,
      reveals: "gemini",
    },
  ];
}

export function EscalationTimeline({ steps, shown }: { steps: TimelineStep[]; shown: number }) {
  return (
    <div className="mt-4 rounded-2xl border border-white/[0.08] bg-ink-900 p-5" data-testid="escalation-timeline">
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/55">Escalation timeline</p>
      <ol className="mt-4 space-y-3">
        {steps.slice(0, shown).map((step) => (
          <li key={step.id} className="flex gap-3 text-sm text-white/80" data-step={step.id}>
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-shield/50 text-shield">
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            <span className="min-w-0">
              <span className="block break-words">{step.text}</span>
              {step.detail ? <span className="mt-0.5 block font-mono text-xs text-white/50">↳ {step.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

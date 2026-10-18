import React from "react";
import type { CloudInferenceVerdict } from "@phishguard/types";
import { Badge, Card, Stat, displayBrand, formatMs, toneFor } from "./shared";

interface TeacherCardProps {
  title: string;
  verdict: CloudInferenceVerdict | null;
  latencyMs: number | null;
  pending: boolean;
}

export function TeacherCard({ title, verdict, latencyMs, pending }: TeacherCardProps) {
  return (
    <Card title={title}>
      {!verdict ? (
        <p className="text-sm text-white/50">{pending ? "Waiting for the cloud verdict…" : "Not escalated yet."}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={toneFor(verdict.actionOverride)} className="px-3 py-1.5 text-xs">
              {verdict.actionOverride}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Phishing" value={verdict.isPhishing ? "yes" : "no"} />
            <Stat label="Confidence" value={verdict.confidence.toFixed(2)} />
            <Stat label="Brand" value={displayBrand(verdict.targetBrand) ?? "none"} />
            <Stat label="Latency" value={formatMs(latencyMs)} />
          </div>
          <ul className="space-y-2 text-sm leading-relaxed text-white/70">
            {verdict.explanationReasons.map((reason, index) => (
              <li key={index} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-white/40" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
          <p className="break-all font-mono text-[11px] text-white/40">{verdict.teacherModelVersion}</p>
        </div>
      )}
    </Card>
  );
}

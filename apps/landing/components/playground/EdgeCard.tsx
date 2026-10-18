import React from "react";
import type { EdgeResult } from "@/lib/playground/demoResults";
import { Badge, Card, RiskMeter, Stat, formatMs, formatScore, toneFor } from "./shared";

export function EdgeCard({ edge, pending }: { edge: EdgeResult | null; pending: boolean }) {
  return (
    <Card title="Tier 1 / On-device student model">
      {!edge ? (
        <p className="text-sm text-white/50">{pending ? "Scoring on-device…" : "Replay the visit to see the on-device score."}</p>
      ) : (
        <>
          <p className="mb-4 font-mono text-xs text-white/55">
            {edge.modelVersion ? `v${edge.modelVersion}` : "model"} · sha256 {edge.modelSha256?.slice(0, 12)}… · {edge.inputContract}
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
            <Stat label="Inference" value={formatMs(edge.latencyMs)} />
            <Stat label="Model score" value={formatScore(edge.modelScore)} />
            <Stat label="Evidence score" value={formatScore(edge.evidenceScore)} />
            <Stat label="Fused score" value={formatScore(edge.fusedScore)} />
          </div>
          <RiskMeter score={edge.fusedScore} />
          <div className="mt-9 flex items-center gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.1em] text-white/45">Route</span>
            <Badge tone={toneFor(edge.route)} className="px-3 py-1.5 text-xs">
              {edge.route}
            </Badge>
          </div>
        </>
      )}
    </Card>
  );
}

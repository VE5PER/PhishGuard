"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { PlaygroundRunResponse, PlaygroundScenarioList } from "@phishguard/types";
import { SectionHeader } from "@/components/SectionHeader";
import { fetchScenarios } from "@/lib/playground/api";
import { getDemoRun, type EdgeResult } from "@/lib/playground/demoResults";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";
import { BrowserFrame } from "./BrowserFrame";
import { EdgeCard } from "./EdgeCard";
import { EscalationTimeline, buildTimelineSteps, type TimelineStep } from "./EscalationTimeline";
import { InspectTabs } from "./InspectTabs";
import { TeacherCard } from "./TeacherCard";
import { Badge, displayBrand } from "./shared";

type Phase = "idle" | "simulating_client" | "scoring" | "client_done" | "escalating_cloud" | "verdict_rendered";

const PHASE_TEXT: Record<Phase, string> = {
  idle: "Ready. Replay the visit to start.",
  simulating_client: "Replaying the visit…",
  scoring: "Scoring on-device…",
  client_done: "On-device pass complete.",
  escalating_cloud: "Escalating to the cloud teachers…",
  verdict_rendered: "Both cloud verdicts received.",
};

const LEAD =
  "Pick a scenario and replay the visit end to end: the on-device verdict, the cloud escalation and the Gemini forensic agent's answer.";

const SCORING_BEAT_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function InteractivePlayground() {
  const reducedMotion = usePrefersReducedMotion();
  const [list, setList] = useState<PlaygroundScenarioList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [edge, setEdge] = useState<EdgeResult | null>(null);
  const [run, setRun] = useState<PlaygroundRunResponse | null>(null);
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [shown, setShown] = useState(0);
  const [evidenceShown, setEvidenceShown] = useState(false);
  const [geminiShown, setGeminiShown] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayToken, setReplayToken] = useState(0);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const runIdRef = useRef(0);
  const replayResolver = useRef<(() => void) | null>(null);

  const loadScenarios = useCallback(() => {
    setLoadError(null);
    fetchScenarios()
      .then((result) => {
        setList(result);
        setActiveId((current) => current ?? result.scenarios[0]?.id ?? null);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Could not load scenarios"));
  }, []);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  const scenario = list?.scenarios.find((item) => item.id === activeId) ?? null;

  const reset = useCallback(() => {
    runIdRef.current += 1;
    replayResolver.current = null;
    setPhase("idle");
    setEdge(null);
    setRun(null);
    setSteps([]);
    setShown(0);
    setEvidenceShown(false);
    setGeminiShown(false);
    setReplaying(false);
    setOverlayDismissed(false);
    setWarningDismissed(false);
  }, []);

  const selectScenario = (id: string) => {
    if (id === activeId) return;
    reset();
    setActiveId(id);
  };

  const escalate = useCallback(
    async (demoRun: PlaygroundRunResponse, runId: number) => {
      const timeline = buildTimelineSteps(demoRun);
      setRun(demoRun);
      setSteps(timeline);
      setShown(0);
      setEvidenceShown(false);
      setGeminiShown(false);
      setPhase("escalating_cloud");
      for (let index = 0; index < timeline.length; index++) {
        if (!reducedMotion) await sleep(timeline[index].delayMs);
        if (runIdRef.current !== runId) return;
        setShown(index + 1);
        if (timeline[index].reveals === "evidence") setEvidenceShown(true);
        if (timeline[index].reveals === "gemini") setGeminiShown(true);
      }
      setPhase("verdict_rendered");
    },
    [reducedMotion],
  );

  const demoRef = useRef<{ edge: EdgeResult; run: PlaygroundRunResponse } | null>(null);

  const start = async () => {
    if (!scenario) return;
    runIdRef.current += 1;
    const runId = runIdRef.current;
    const demo = getDemoRun(scenario);
    demoRef.current = demo;
    setEdge(null);
    setRun(null);
    setSteps([]);
    setShown(0);
    setEvidenceShown(false);
    setGeminiShown(false);
    setOverlayDismissed(false);
    setWarningDismissed(false);
    setPhase("simulating_client");
    const replayDone = new Promise<void>((resolve) => {
      replayResolver.current = resolve;
    });
    setReplaying(true);
    setReplayToken((token) => token + 1);
    await replayDone;
    if (runIdRef.current !== runId) return;
    setPhase("scoring");
    if (!reducedMotion) await sleep(SCORING_BEAT_MS);
    if (runIdRef.current !== runId) return;
    setEdge(demo.edge);
    if (demo.edge.route === "AMBIGUOUS") {
      await escalate(demo.run, runId);
    } else {
      setPhase("client_done");
    }
  };

  const manualEscalate = () => {
    if (demoRef.current) void escalate(demoRef.current.run, runIdRef.current);
  };

  const busy = phase === "simulating_client" || phase === "scoring" || phase === "escalating_cloud";
  const flagged = edge ? Array.from(new Set(edge.reasons)) : [];
  const geminiVerdict = geminiShown && run ? run.gemini.verdict : null;
  const cloudBlock = geminiVerdict?.actionOverride === "BLOCK";
  const blockOverlay =
    !overlayDismissed && scenario && (edge?.route === "BLOCK" || cloudBlock)
      ? {
          brand: displayBrand(geminiVerdict?.targetBrand),
          reasons: cloudBlock && geminiVerdict ? geminiVerdict.explanationReasons.slice(0, 4) : flagged.slice(0, 4),
        }
      : null;
  const warnBanner =
    !warningDismissed && geminiVerdict?.actionOverride === "WARN"
      ? { brand: displayBrand(geminiVerdict.targetBrand), reason: geminiVerdict.explanationReasons[0] ?? null }
      : null;

  return (
    <section id="playground" data-page className="py-[clamp(2rem,4vw,3rem)]">
      <div className="container-x max-w-[1400px]">
        <SectionHeader label="Playground" title="Try it on three pages. No install." lead={LEAD} />

        {loadError ? (
          <div className="mt-10 rounded-2xl border border-alert/40 bg-alert/10 p-5 text-sm text-alert">
            {loadError}{" "}
            <button onClick={loadScenarios} className="ml-2 underline">
              Retry
            </button>
          </div>
        ) : !list || !scenario ? (
          <p className="mt-10 font-mono text-sm text-white/50">Loading scenarios…</p>
        ) : (
          <>
            <div role="tablist" aria-label="Scenarios" className="mt-10 grid gap-3 md:grid-cols-3">
              {list.scenarios.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={item.id === activeId}
                  onClick={() => selectScenario(item.id)}
                  className={cn(
                    "rounded-2xl border p-4 text-left transition-colors",
                    item.id === activeId ? "border-shield/60 bg-shield/[0.06]" : "border-white/[0.1] bg-ink-900 hover:border-white/30",
                  )}
                >
                  <span className="block font-display text-base font-semibold text-white">{item.title}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-white/55">{item.tagline}</span>
                </button>
              ))}
            </div>

            <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
              <div className="lg:col-span-8">
                <BrowserFrame
                  scenario={scenario}
                  trajectory={scenario.payload.mouseTrajectorySeries}
                  edgeRoute={edge?.route ?? null}
                  replayToken={replayToken}
                  replaying={replaying}
                  reducedMotion={reducedMotion}
                  onReplayDone={() => replayResolver.current?.()}
                  blockOverlay={blockOverlay}
                  warnBanner={warnBanner}
                  onLeave={reset}
                  onIgnore={() => setOverlayDismissed(true)}
                  onDismissWarning={() => setWarningDismissed(true)}
                />
                {steps.length > 0 ? <EscalationTimeline steps={steps} shown={shown} /> : null}
              </div>

              <div className="space-y-5 lg:col-span-4">
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.08] bg-ink-900 p-4">
                  <button
                    onClick={start}
                    disabled={busy}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-shield px-5 text-sm font-bold text-ink-950 transition-[filter,transform] hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play className="h-4 w-4" />
                    Replay visit
                  </button>
                  {phase === "client_done" && edge?.route === "SAFE" && (
                    <button onClick={manualEscalate} className="min-h-[44px] rounded-full border border-white/20 px-5 text-sm font-semibold text-white hover:border-white/50">
                      Escalate anyway
                    </button>
                  )}
                  {phase === "client_done" && edge?.route === "BLOCK" && (
                    <button onClick={manualEscalate} className="min-h-[44px] rounded-full border border-quarantine/60 px-5 text-sm font-semibold text-quarantine hover:bg-quarantine/10">
                      Request forensic explanation
                    </button>
                  )}
                  <div className="min-w-0 flex-1 basis-48" aria-live="polite" data-phase={phase}>
                    <p className="text-sm text-white/70">{PHASE_TEXT[phase]}</p>
                    {phase === "client_done" && edge?.route === "SAFE" && (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-shield">
                        <Badge tone="shield">SAFE</Badge> No network call made — silent pass
                      </p>
                    )}
                    {phase === "client_done" && edge?.route === "BLOCK" && (
                      <p className="mt-1 text-sm text-quarantine">Blocked on-device. The cloud was not contacted yet.</p>
                    )}
                  </div>
                </div>

                <EdgeCard edge={edge} pending={phase === "simulating_client" || phase === "scoring"} />
                <TeacherCard
                  title="Tier 2 / Evidence policy v2"
                  verdict={evidenceShown && run ? run.evidence.verdict : null}
                  latencyMs={run?.evidence.latencyMs ?? null}
                  pending={phase === "escalating_cloud"}
                />
                <TeacherCard
                  title="Tier 2 / Gemini forensic agent (ADK)"
                  verdict={geminiVerdict}
                  latencyMs={run?.gemini.latencyMs ?? null}
                  pending={phase === "escalating_cloud"}
                />
              </div>
            </div>

            <div className="mt-8 rounded-2xl border border-white/[0.08] bg-ink-900 p-5">
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/55">Flagged page evidence</p>
              {edge ? (
                flagged.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 text-sm text-white/75">
                    {flagged.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-alert" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-white/60">No page evidence flagged</p>
                )
              ) : (
                <p className="mt-3 text-sm text-white/45">Appears after the on-device pass.</p>
              )}
            </div>

            <InspectTabs payload={scenario.payload} label="this visit" run={phase === "verdict_rendered" ? run : null} />
          </>
        )}
      </div>
    </section>
  );
}

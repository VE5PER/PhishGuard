"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { Check, Lock } from "lucide-react";
import { BlockOverlayReplica } from "@/components/replica/BlockOverlayReplica";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useProductFacts } from "@/lib/useProductFacts";
import { cn } from "@/lib/utils";

export type StageBeat = 0 | 1 | 2 | 3 | 4;

interface BrowserStageProps {
  beat: StageBeat;
  running: boolean;
  durationMs: number;
  className?: string;
  onNextBeat?: () => void;
  onPrevBeat?: () => void;
}

const STAGE_REASONS = [
  "Domain 'paypa1.xyz' impersonates brand 'PayPal' without official domain authorization",
  "Page visually matches PayPal's login page (similarity 0.97) but is hosted on paypa1.xyz",
];

const BAR_HEIGHTS = [5, 10, 7, 13, 6, 11, 8, 14, 6, 10];

const MONO_LABEL = "absolute whitespace-nowrap font-mono text-[11px] leading-none";

const CLOUD_STREAMS = ["Interaction timing", "Page structure", "Screenshot · opt-in"];

const CLOUD_TOOL_CALLS = [
  { name: "verify_brand_official_domain", result: "paypal.com ≠ paypa1.xyz" },
  { name: "lookup_threat_memory_bank", result: "prior BLOCK" },
];

const SIGNALS = [
  { label: "Interaction", value: 0.71, color: "#C6F432" },
  { label: "Page", value: 0.92, color: "#FFB224" },
  { label: "Vision", value: 0.88, color: "#FFB224" },
];

const delay = (ms: number): React.CSSProperties => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const HUMAN_PATH = "M 40 340 C 110 120, 240 380, 330 150";
const SCRIPTED_PATH = "M 50 70 L 350 285";
const HUMAN_END = { x: 330, y: 150 };
const SCRIPTED_END = { x: 350, y: 285 };
const CURSOR_ARROW = "M0 0 L0 16 L4.2 12.2 L7.4 19 L10 17.8 L6.9 11.2 L12 11.2 Z";
const BASE = {
  draw: 1100,
  fade: 600,
  grow: 900,
  sweep: 1400,
  cursorFade: 150,
  scriptedDelay: 600,
  scoreTween: 900,
} as const;

const T = {
  humanPath: 0,
  scriptedPath: BASE.scriptedDelay,
  humanLabel: 300,
  scriptedLabel: 900,
  barStagger: 40,
  outline: 0,
  outlineLabel: 150,
  frame: 300,
  frameLabel: 450,
  chip: 600,
  sweep: 0,
  logo: 500,
  logoLabel: 800,
  hostLabel: 1100,
  signalStagger: 120,
  meter: 300,
  overlay: 1100,
  cloudChip: 0,
  cloudCard: 150,
  cloudStream: 450,
  cloudStreamStagger: 250,
  cloudTool: 1250,
  cloudToolStagger: 350,
  cloudVerdict: 2000,
  cloudFallback: 2300,
} as const;

const BAR_COUNT = BAR_HEIGHTS.length;
const SIGNAL_COUNT = 3;
const ANIMATION_SHARE = 0.8;

export const STAGE_BASE_END_MS: readonly [number, number, number, number, number] = [
  Math.max(
    T.humanPath + BASE.draw,
    T.scriptedPath + BASE.draw,
    T.humanLabel + BASE.fade,
    T.scriptedLabel + BASE.fade,
    (BAR_COUNT - 1) * T.barStagger + BASE.grow
  ),
  Math.max(T.outline, T.outlineLabel, T.frame, T.frameLabel, T.chip) + BASE.fade,
  Math.max(T.sweep + BASE.sweep, T.logo + BASE.fade, T.logoLabel + BASE.fade, T.hostLabel + BASE.fade),
  Math.max(
    (SIGNAL_COUNT - 1) * T.signalStagger + BASE.grow,
    T.meter + BASE.grow,
    BASE.scoreTween,
    T.overlay + BASE.fade
  ),
  Math.max(T.cloudChip, T.cloudCard, T.cloudVerdict, T.cloudFallback, T.cloudTool + T.cloudToolStagger) + BASE.fade,
];

const SCORE_FINAL = 0.94;

function ScoreCounter({ active, tweenMs }: { active: boolean; tweenMs: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const textNode = ref.current?.firstChild;
    if (!textNode) return;
    if (reducedMotion || !active) {
      textNode.nodeValue = reducedMotion ? SCORE_FINAL.toFixed(2) : (0).toFixed(2);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / tweenMs, 1);
      textNode.nodeValue = (SCORE_FINAL * (1 - Math.pow(1 - t, 3))).toFixed(2);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reducedMotion, tweenMs]);

  return (
    <span ref={ref} className="font-display text-5xl font-bold leading-none text-quarantine">
      {SCORE_FINAL.toFixed(2)}
    </span>
  );
}

function beginMotion(el: SVGElement | null) {
  if (el instanceof SVGAnimationElement) el.beginElement();
}

function endMotion(el: SVGElement | null) {
  if (el instanceof SVGAnimationElement) el.endElement();
}

function TrajectoryCursors({
  active,
  durationS,
  scriptedDelayMs,
  fadeMs,
}: {
  active: boolean;
  durationS: string;
  scriptedDelayMs: number;
  fadeMs: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const humanGroup = useRef<SVGGElement>(null);
  const humanMotion = useRef<SVGElement>(null);
  const scriptedGroup = useRef<SVGGElement>(null);
  const scriptedMotion = useRef<SVGElement>(null);

  useEffect(() => {
    if (reducedMotion || !active) return;
    const human = humanGroup.current;
    const scripted = scriptedGroup.current;
    if (!human || !scripted) return;

    human.style.opacity = "1";
    beginMotion(humanMotion.current);
    const timer = window.setTimeout(() => {
      scripted.style.opacity = "1";
      beginMotion(scriptedMotion.current);
    }, scriptedDelayMs);

    return () => {
      window.clearTimeout(timer);
      endMotion(humanMotion.current);
      endMotion(scriptedMotion.current);
      human.style.opacity = "0";
      scripted.style.opacity = "0";
    };
  }, [active, reducedMotion, scriptedDelayMs]);

  const hiddenStyle: React.CSSProperties = reducedMotion ? {} : { opacity: 0, transition: `opacity ${fadeMs}ms ease` };

  return (
    <>
      <g
        ref={humanGroup}
        aria-hidden="true"
        style={hiddenStyle}
        transform={reducedMotion ? `translate(${HUMAN_END.x} ${HUMAN_END.y})` : undefined}
      >
        {!reducedMotion && (
          <animateMotion
            ref={humanMotion}
            path={HUMAN_PATH}
            dur={durationS}
            begin="indefinite"
            fill="freeze"
            calcMode="spline"
            keyTimes="0;1"
            keyPoints="0;1"
            keySplines="0.16 1 0.3 1"
          />
        )}
        <circle r={7} fill="rgba(198,244,50,0.25)" />
        <path d={CURSOR_ARROW} fill="#FFFFFF" stroke="#08090A" strokeWidth={1.2} strokeLinejoin="round" />
      </g>
      <g
        ref={scriptedGroup}
        aria-hidden="true"
        style={hiddenStyle}
        transform={reducedMotion ? `translate(${SCRIPTED_END.x} ${SCRIPTED_END.y})` : undefined}
      >
        {!reducedMotion && (
          <animateMotion
            ref={scriptedMotion}
            path={SCRIPTED_PATH}
            dur={durationS}
            begin="indefinite"
            fill="freeze"
            calcMode="linear"
          />
        )}
        <path d={CURSOR_ARROW} fill="#FF5A46" stroke="#08090A" strokeWidth={1.2} strokeLinejoin="round" />
        <text x={14} y={26} fontSize={9} fill="#FF5A46" fontFamily="ui-monospace, monospace">
          BOT
        </text>
      </g>
    </>
  );
}

export function BrowserStage({
  beat,
  running,
  durationMs,
  className,
  onNextBeat,
  onPrevBeat,
}: BrowserStageProps) {
  const facts = useProductFacts();
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(deltaX) > 36 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
      if (deltaX < 0) {
        onNextBeat?.();
      } else {
        onPrevBeat?.();
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  const activationDurationMs = useMemo(() => durationMs, [beat, running]); // eslint-disable-line react-hooks/exhaustive-deps
  const speedFor = (index: StageBeat): number => STAGE_BASE_END_MS[index] / (ANIMATION_SHARE * activationDurationMs);

  const layerContent = (index: StageBeat, speed: number) => {
    const t = (ms: number): number => Math.round(ms / speed);
    switch (index) {
      case 0:
        return (
          <>
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 500 400" fill="none" aria-hidden="true">
              <path
                data-anim="draw"
                d={HUMAN_PATH}
                pathLength={1}
                stroke="#C6F432"
                strokeWidth={2.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                style={delay(t(T.humanPath))}
              />
              <path
                data-anim="draw"
                d={SCRIPTED_PATH}
                pathLength={1}
                stroke="#FF5A46"
                strokeWidth={2.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                style={{ ...delay(t(BASE.scriptedDelay)), transitionTimingFunction: "linear" }}
              />
              <TrajectoryCursors
                active={running && beat === 0}
                durationS={`${(BASE.draw / speed / 1000).toFixed(4)}s`}
                scriptedDelayMs={t(BASE.scriptedDelay)}
                fadeMs={t(BASE.cursorFade)}
              />
            </svg>
            <div
              data-anim="fade"
              className={cn(MONO_LABEL, "left-[4%] top-[88%] rounded-full bg-ink-950/90 px-2.5 py-1.5 text-shield")}
              style={delay(t(T.humanLabel))}
            >
              142 px/s · natural
            </div>
            <div
              data-anim="fade"
              className={cn(MONO_LABEL, "right-[4%] top-[88%] rounded-full bg-ink-950/90 px-2.5 py-1.5 text-quarantine")}
              style={delay(t(T.scriptedLabel))}
            >
              3,400 px/s · scripted
            </div>
            <div className="absolute left-[27%] top-[78%] flex h-4 w-[46%] items-end gap-1">
              {BAR_HEIGHTS.map((h, i) => (
                <span
                  key={i}
                  data-anim="grow-y"
                  className="w-full rounded-sm bg-white/30"
                  style={{ height: h, ...delay(i * t(T.barStagger)) }}
                />
              ))}
            </div>
            <div className={cn(MONO_LABEL, "left-[27%] top-[93%] text-white/55")}>Typing rhythm · timing only</div>
          </>
        );
      case 1:
        return (
          <>
            <div
              data-anim="fade"
              className="absolute left-[26%] top-[64%] h-[12%] w-[48%] rounded-full border-2 border-dashed border-quarantine"
              style={delay(t(T.outline))}
            />
            <div data-anim="fade" className={cn(MONO_LABEL, "left-[26%] top-[78%] text-quarantine")} style={delay(t(T.outlineLabel))}>
              opacity: 0 overlay
            </div>
            <div
              data-anim="fade"
              className="absolute left-[26%] top-[47.5%] h-[12%] w-[48%] rounded-md border-2 border-dashed border-alert"
              style={delay(t(T.frame))}
            />
            <div data-anim="fade" className={cn(MONO_LABEL, "right-[26%] top-[43%] text-alert")} style={delay(t(T.frameLabel))}>
              cross-origin frame
            </div>
            <div
              data-anim="fade"
              className={cn(MONO_LABEL, "left-1/2 top-[2.5%] -translate-x-1/2 rounded-full border border-quarantine/60 bg-ink-950/90 px-3 py-1.5 text-quarantine")}
              style={delay(t(T.chip))}
            >
              paypa1.xyz ≠ paypal.com
            </div>
          </>
        );
      case 2:
        return (
          <>
            <div
              data-anim="sweep"
              className="pointer-events-none absolute inset-0"
              style={{ "--sweep-to": "100%", ...delay(t(T.sweep)) } as React.CSSProperties}
            >
              <div className="h-0.5 bg-shield shadow-[0_0_16px_rgba(198,244,50,0.7)]" />
            </div>
            <div
              data-anim="fade"
              className="absolute left-[38%] top-[9%] h-[12%] w-[24%] rounded-md border-2 border-shield"
              style={delay(t(T.logo))}
            />
            <div data-anim="fade" className={cn(MONO_LABEL, "left-[38%] top-[23%] text-shield")} style={delay(t(T.logoLabel))}>
              PayPal logo · 97% match
            </div>
            <div data-anim="fade" className={cn(MONO_LABEL, "left-[38%] top-[28%] text-quarantine")} style={delay(t(T.hostLabel))}>
              Hosted on paypa1.xyz
            </div>
            <div className={cn(MONO_LABEL, "bottom-[3%] right-[3%] rounded-full bg-ink-950/90 px-2.5 py-1.5 text-white/70")}>
              {facts.visionInput} · on-device · never stored
            </div>
          </>
        );
      case 3:
        return (
          <>
            <div className="absolute inset-[12%_8%_12%_8%] rounded-xl border border-white/10 bg-ink-950/90 p-5">
              <div className="space-y-3">
                {SIGNALS.map((signal, i) => (
                  <div key={signal.label}>
                    <div className="mb-1 flex justify-between font-mono text-[11px] text-white/70">
                      <span>{signal.label}</span>
                      <span>{signal.value.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/[0.08]">
                      <div
                        data-anim="grow-x"
                        className="h-full rounded-full"
                        style={{ width: `${signal.value * 100}%`, backgroundColor: signal.color, ...delay(i * t(T.signalStagger)) }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-end justify-between">
                <span className="font-mono text-[11px] uppercase tracking-wider text-white/55">Fused score</span>
                <ScoreCounter active={running && beat === 3} tweenMs={t(BASE.scoreTween)} />
              </div>
              <div
                className="relative mt-4 h-1.5 rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, rgba(198,244,50,.18) 0 15%, rgba(255,178,36,.18) 15% 85%, rgba(255,90,70,.18) 85% 100%)",
                }}
              >
                <span className="absolute -bottom-[3px] -top-[3px] left-[15%] w-px bg-white/[0.14]" />
                <span className="absolute -bottom-[3px] -top-[3px] left-[85%] w-px bg-white/[0.14]" />
                <div
                  data-anim="grow-x"
                  className="h-full rounded-full bg-quarantine"
                  style={{ width: "94%", ...delay(t(T.meter)) }}
                />
              </div>
            </div>

            <div data-anim="fade" className="pointer-events-none absolute inset-0" style={delay(t(T.overlay))}>
              <div className="absolute left-0 top-0 h-[200%] w-[200%] origin-top-left scale-50">
                <BlockOverlayReplica brand="PayPal" reasons={STAGE_REASONS} />
              </div>
            </div>
          </>
        );
      case 4:
        return (
          <>
            <div
              data-anim="fade"
              className={cn(MONO_LABEL, "left-1/2 top-[2.5%] -translate-x-1/2 rounded-full border border-alert/60 bg-ink-950/90 px-3 py-1.5 text-alert")}
              style={delay(t(T.cloudChip))}
            >
              Suspicious · 0.52
            </div>
            <div
              data-anim="fade"
              className="absolute inset-[12%_6%_13%_6%] overflow-hidden rounded-xl border border-white/10 bg-ink-950/90 p-3 sm:p-5"
              style={delay(t(T.cloudCard))}
            >
              <div className="truncate font-mono text-[11px] uppercase tracking-wider text-white/55">
                Cloud check · Gemini ADK agent
              </div>
              <ul className="mt-2 space-y-1 sm:mt-3 sm:space-y-1.5">
                {CLOUD_STREAMS.map((stream, i) => (
                  <li
                    key={stream}
                    data-anim="fade"
                    className="flex items-center gap-2 font-mono text-[11px] text-white/80"
                    style={delay(t(T.cloudStream) + i * t(T.cloudStreamStagger))}
                  >
                    <Check className="h-3 w-3 shrink-0 text-shield" aria-hidden="true" />
                    <span className="truncate">{stream}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 space-y-1 sm:mt-3">
                {CLOUD_TOOL_CALLS.map((call, i) => (
                  <div
                    key={call.name}
                    data-anim="fade"
                    className="truncate font-mono text-[10px] text-white/60 sm:text-[11px]"
                    style={delay(t(T.cloudTool) + i * t(T.cloudToolStagger))}
                  >
                    {call.name} <span className="text-quarantine">→ {call.result}</span>
                  </div>
                ))}
              </div>
              <div
                data-anim="fade"
                className="mt-2 flex items-end justify-between border-t border-white/[0.08] pt-2 sm:mt-3 sm:pt-3"
                style={delay(t(T.cloudVerdict))}
              >
                <span className="font-mono text-[11px] uppercase tracking-wider text-white/55">Verdict</span>
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-white/45">gemini-adk</span>
                  <span className="font-display text-2xl font-bold leading-none text-quarantine">BLOCK</span>
                </span>
              </div>
            </div>
            <div
              data-anim="fade"
              className={cn(MONO_LABEL, "bottom-[3%] right-[3%] rounded-full bg-ink-950/90 px-2.5 py-1.5 text-white/70")}
              style={delay(t(T.cloudFallback))}
            >
              Fallback · gateway checks
            </div>
          </>
        );
      default:
        return null;
    }
  };

  const layers: StageBeat[] = [0, 1, 2, 3, 4];

  return (
    <div
      data-stage
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className={cn("overflow-hidden rounded-2xl border border-white/10 bg-ink-900 select-none touch-pan-y", className)}
    >
      <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-full bg-ink-950 px-3 py-1.5 font-mono text-xs">
          <Lock className="h-3.5 w-3.5 shrink-0 text-white/55" />
          <span className="text-white/55">https://</span>
          <span className="truncate font-medium text-white">paypa1.xyz/signin</span>
        </div>
      </div>

      <div className="relative aspect-[5/4] w-full bg-ink-950">
        <div className="absolute inset-[7%_20%_7%_20%] rounded-xl border border-white/[0.08] bg-ink-900" />
        <div className="absolute left-[20%] top-[11%] w-[60%] text-center font-display text-3xl font-bold italic tracking-tight text-white/85">
          PayPaI
        </div>
        <div className="absolute left-[27%] top-[34%] h-[9%] w-[46%] rounded-md border border-white/10 bg-ink-950 px-3 py-2 text-xs text-white/55">
          <span className="font-mono">email@example.com</span>
        </div>
        <div className="absolute left-[27%] top-[49%] h-[9%] w-[46%] rounded-md border border-white/10 bg-ink-950 px-3 py-2 text-xs tracking-[0.3em] text-white/70">
          ••••••••
        </div>
        <div className="absolute left-[27%] top-[65%] flex h-[10%] w-[46%] items-center justify-center rounded-full bg-white/80 text-sm font-bold text-ink-950">
          Log In
        </div>

        {layers.map((index) => (
          <div
            key={index}
            data-scene
            data-active={running && beat === index}
            style={{ "--stage-speed": speedFor(index) } as React.CSSProperties}
            className={cn(
              "absolute inset-0 transition-opacity duration-200",
              beat === index ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            {layerContent(index, speedFor(index))}
          </div>
        ))}
      </div>
    </div>
  );
}

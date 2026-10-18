"use client";

import React, { useEffect, useState } from "react";
import { Search, BrainCircuit, Layers, ShieldCheck, Play, Pause, type LucideIcon } from "lucide-react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";

export interface LifecyclePipelineTrackProps {
  activeStage: number;
  onSelectStage: (stage: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  className?: string;
}

interface PhaseInfo {
  num: string;
  shortLabel: string;
  icon: LucideIcon;
  telemetry: string;
}

const PHASES: PhaseInfo[] = [
  {
    num: "1",
    shortLabel: "01",
    icon: Search,
    telemetry: "Threat harvest: Ingesting newly reported phishing DOMs & benign anchors",
  },
  {
    num: "2",
    shortLabel: "02",
    icon: BrainCircuit,
    telemetry: "Cloud Teacher: Fusing vision tokens, DOM hierarchy & behavioral kinematics",
  },
  {
    num: "3",
    shortLabel: "03",
    icon: Layers,
    telemetry: "Distillation: Compressing teacher logits into 1.2 MB INT8 on-device engine",
  },
  {
    num: "4",
    shortLabel: "04",
    icon: ShieldCheck,
    telemetry: "Verified swap: SHA-256 cryptographic check and quiet browser extension hot-swap",
  },
];

export function LifecyclePipelineTrack({
  activeStage,
  onSelectStage,
  isPlaying,
  onTogglePlay,
  className,
}: LifecyclePipelineTrackProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reducedMotion || !isPlaying) return;
    const interval = setInterval(() => {
      setTick((prev) => (prev + 1) % 100);
    }, 45);
    return () => clearInterval(interval);
  }, [reducedMotion, isPlaying]);

  const activePhase = PHASES[activeStage] ?? PHASES[0];

  return (
    <div
      className={cn(
        "relative rounded-xl border border-white/[0.08] bg-ink-900/50 p-4 sm:p-5 backdrop-blur-sm",
        className
      )}
      aria-label="PhishGuard model lifecycle connected animation track"
    >
      {/* Connected Animation Track: Nodes 1 -> 2 -> 3 -> 4 with Training Distillation Connection */}
      <div className="relative">
        <svg
          viewBox="0 0 1000 80"
          className="h-[75px] sm:h-[80px] w-full overflow-visible select-none"
          aria-hidden="true"
        >
          <defs>
            {/* Standard pulse bus gradient */}
            <linearGradient id="busGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
              <stop offset="50%" stopColor="#C6F432" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.12)" />
            </linearGradient>

            {/* Subtle glow filter */}
            <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* ---------------- 1 -> 2: Dataset Feed Bus (Center 125 to Center 375) ---------------- */}
          <line
            x1="155"
            y1="40"
            x2="345"
            y2="40"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          {(activeStage === 0 || activeStage === 1) && !reducedMotion && (
            <>
              <line
                x1="155"
                y1="40"
                x2="345"
                y2="40"
                stroke="url(#busGrad)"
                strokeWidth="2"
                strokeDasharray="10 6"
                style={{ strokeDashoffset: -(tick * 2.2) }}
              />
              <circle
                cx={155 + ((tick * 1.9) % 190)}
                cy="40"
                r="3"
                fill="#C6F432"
                filter="url(#softGlow)"
              />
            </>
          )}

          {/* ---------------- 2 -> 3: MODEL TRAINING & DISTILLATION ARROW (Center 375 to Center 625) ---------------- */}
          {/* Multi-stream converging synaptic loss pathways: Vision, DOM, Kinematics */}
          {/* Training badge */}
          <rect
            x="455"
            y="12"
            width="90"
            height="16"
            rx="8"
            fill="rgba(14, 15, 17, 0.9)"
            stroke={activeStage === 1 || activeStage === 2 ? "rgba(198, 244, 50, 0.6)" : "rgba(255, 255, 255, 0.1)"}
            strokeWidth="1"
          />
          <text
            x="500"
            y="23"
            textAnchor="middle"
            className={cn(
              "font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors",
              activeStage === 1 || activeStage === 2 ? "fill-shield" : "fill-white/40"
            )}
          >
            ∿ MODEL TRAINING
          </text>

          {/* Channel A: Top loss wave (Vision stream) */}
          <path
            d="M 405 28 C 445 20, 510 24, 545 32 C 565 37, 580 40, 595 40"
            fill="none"
            stroke={activeStage === 1 || activeStage === 2 ? "rgba(255, 178, 36, 0.85)" : "rgba(255, 255, 255, 0.12)"}
            strokeWidth="1.5"
            strokeDasharray={reducedMotion ? "none" : "6 4"}
            style={{ strokeDashoffset: reducedMotion ? 0 : -(tick * 2.5) }}
          />

          {/* Channel B: Center loss wave (DOM graph & Kinematics) */}
          <path
            d="M 405 40 C 455 40, 515 40, 545 40 C 565 40, 580 40, 595 40"
            fill="none"
            stroke={activeStage === 1 || activeStage === 2 ? "#C6F432" : "rgba(255, 255, 255, 0.2)"}
            strokeWidth="2"
            strokeDasharray={reducedMotion ? "none" : "8 5"}
            style={{ strokeDashoffset: reducedMotion ? 0 : -(tick * 3.2) }}
          />

          {/* Channel C: Bottom loss wave (Softmax logits) */}
          <path
            d="M 405 52 C 445 60, 510 56, 545 48 C 565 43, 580 40, 595 40"
            fill="none"
            stroke={activeStage === 1 || activeStage === 2 ? "rgba(198, 244, 50, 0.85)" : "rgba(255, 255, 255, 0.12)"}
            strokeWidth="1.5"
            strokeDasharray={reducedMotion ? "none" : "6 4"}
            style={{ strokeDashoffset: reducedMotion ? 0 : -(tick * 2.5) }}
          />

          {/* Focal distillation point entering Node 3 */}
          <circle
            cx="595"
            cy="40"
            r="4"
            fill={activeStage === 1 || activeStage === 2 ? "#C6F432" : "#9CC21F"}
            filter="url(#softGlow)"
            className={activeStage === 1 || activeStage === 2 ? "animate-pulse" : ""}
          />

          {/* Converging training particles */}
          {!reducedMotion && (activeStage === 1 || activeStage === 2) && (
            <>
              <circle
                cx={405 + ((tick * 1.8) % 185)}
                cy={28 + Math.sin(tick * 0.25) * 4}
                r="2.5"
                fill="#FFB224"
              />
              <circle
                cx={405 + ((tick * 2.2) % 185)}
                cy="40"
                r="3"
                fill="#C6F432"
                filter="url(#softGlow)"
              />
              <circle
                cx={405 + (((tick + 50) * 1.8) % 185)}
                cy={52 - Math.sin(tick * 0.25) * 4}
                r="2.5"
                fill="#C6F432"
              />
            </>
          )}

          {/* Distillation arrow head into node 3 */}
          <path
            d="M 590 36 L 598 40 L 590 44"
            fill="none"
            stroke={activeStage === 1 || activeStage === 2 ? "#C6F432" : "rgba(255,255,255,0.3)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* ---------------- 3 -> 4: Verified Dispatch Bus (Center 625 to Center 875) ---------------- */}
          <line
            x1="655"
            y1="40"
            x2="845"
            y2="40"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          {(activeStage === 2 || activeStage === 3) && !reducedMotion && (
            <>
              <line
                x1="655"
                y1="40"
                x2="845"
                y2="40"
                stroke="url(#busGrad)"
                strokeWidth="2"
                strokeDasharray="10 6"
                style={{ strokeDashoffset: -(tick * 2.2) }}
              />
              <circle
                cx={655 + ((tick * 1.9) % 190)}
                cy="40"
                r="3"
                fill="#C6F432"
                filter="url(#softGlow)"
              />
            </>
          )}
        </svg>

        {/* 4 Interactive Node Badges directly positioned under each card center (x ~ 125, 375, 625, 875) */}
        <div className="absolute inset-0 flex items-center justify-between px-[3%] sm:px-[6%] lg:px-[8%] pointer-events-none">
          {PHASES.map((phase, idx) => {
            const Icon = phase.icon;
            const isActive = idx === activeStage;

            return (
              <button
                key={phase.num}
                type="button"
                onClick={() => onSelectStage(idx)}
                className={cn(
                  "pointer-events-auto group relative flex items-center gap-1 sm:gap-1.5 rounded-full border px-2.5 py-1.5 sm:px-3 sm:py-1.5 min-h-[38px] font-mono text-[11px] sm:text-xs transition-all duration-300",
                  isActive
                    ? "border-shield bg-shield/20 text-white shadow-[0_0_16px_rgba(198,244,50,0.5)] scale-105 sm:scale-110"
                    : "border-white/[0.12] bg-ink-950/90 text-white/60 hover:border-white/30 hover:text-white"
                )}
                aria-pressed={isActive}
                aria-label={`Jump to stage ${phase.num}`}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                    isActive ? "bg-shield text-ink-950 font-bold" : "bg-white/10 text-white/70"
                  )}
                >
                  {phase.num}
                </span>
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 transition-colors",
                    isActive ? "text-shield" : "text-white/50 group-hover:text-white"
                  )}
                  strokeWidth={2}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* Single Dynamic Telemetry Bar + Compact Play/Pause Control (Zero redundant duplicate cards) */}
      <div className="mt-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 border-t border-white/[0.06] pt-3 font-mono text-xs text-white/70">
        <div className="flex items-start sm:items-center gap-2 min-w-0 flex-1">
          <span className="mt-1 sm:mt-0 flex h-2 w-2 shrink-0 rounded-full bg-shield animate-pulse" />
          <span className="text-[11px] leading-relaxed text-white/80 sm:text-xs">{activePhase.telemetry}</span>
        </div>

        <button
          type="button"
          onClick={onTogglePlay}
          className="self-end sm:self-auto flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-shield/40 hover:text-white"
          title={isPlaying ? "Pause cycle" : "Play cycle"}
          aria-label={isPlaying ? "Pause cycle" : "Play cycle"}
        >
          {isPlaying ? (
            <>
              <Pause className="h-3.5 w-3.5 text-shield" />
              <span>Pause</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 text-shield" />
              <span>Play</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

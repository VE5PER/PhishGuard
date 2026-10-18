"use client";

import React, { useState, useEffect, useRef } from "react";
import { Search, BrainCircuit, Layers, ShieldCheck, RefreshCw } from "lucide-react";
import { SectionHeader } from "@/components/SectionHeader";
import { LifecyclePipelineTrack } from "@/components/LifecyclePipelineTrack";
import { fmtKB, fmtPct, type ProductFacts } from "@/lib/facts";
import { useProductFacts } from "@/lib/useProductFacts";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useSceneInView } from "@/lib/useSceneInView";
import { useReveal } from "@/lib/useReveal";
import { cn } from "@/lib/utils";

const getStages = (facts: ProductFacts) => [
  {
    num: "01",
    icon: Search,
    title: "Discover",
    tagline: "Dataset agent",
    description: "Collects newly reported phishing pages—and real ones for contrast—every day.",
    specs: ["Daily sweep", "No personal data"],
  },
  {
    num: "02",
    icon: BrainCircuit,
    title: "Learn",
    tagline: "Cloud teacher",
    description: "A large model studies how each page looks, how it's built and how it's used.",
    specs: ["Vision + structure + behavior", `≥${fmtPct(facts.teacherAccuracyGate)} accuracy gate`],
  },
  {
    num: "03",
    icon: Layers,
    title: "Distill",
    tagline: "Student model",
    description: `Its judgment is compressed into a ${fmtKB(facts.modelSizeBytes)} model that runs on-device in your browser.`,
    specs: [fmtKB(facts.modelSizeBytes), `≥${fmtPct(facts.accuracyGate)} accuracy gate`],
  },
  {
    num: "04",
    icon: ShieldCheck,
    title: "Deliver",
    tagline: "Verified update",
    description: "Your extension checks hourly, verifies the hash and swaps it in quietly.",
    specs: ["SHA-256 verified", "No reinstall"],
  },
];

export function ModelLifecycle() {
  const facts = useProductFacts();
  const STAGES = getStages(facts);
  const stagesRef = useReveal<HTMLOListElement>();
  const [sectionRef, inView] = useSceneInView<HTMLElement>(0.15);
  const reducedMotion = usePrefersReducedMotion();

  const [activeStage, setActiveStage] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  // Auto-advance loop: forward-only (0 -> 1 -> 2 -> 3 -> 0)
  useEffect(() => {
    if (!isPlaying || !inView || reducedMotion) return;
    const interval = setInterval(() => {
      setActiveStage((prev) => (prev + 1) % 4);
    }, 3800);
    return () => clearInterval(interval);
  }, [isPlaying, inView, reducedMotion]);

  const handleSelectStage = (idx: number) => {
    setActiveStage(idx);
    setIsPlaying(false);
  };

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
        handleSelectStage((activeStage + 1) % STAGES.length);
      } else {
        handleSelectStage((activeStage - 1 + STAGES.length) % STAGES.length);
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  return (
    <section
      id="models"
      data-page
      ref={sectionRef}
      className="relative overflow-hidden border-t lg:flex lg:min-h-[100svh] lg:flex-col lg:justify-center border-white/[0.08] py-[clamp(6rem,10vw,10rem)]"
    >
      <div className="container-x">
        <SectionHeader
          label="How our models learn"
          title="Smarter every day. Still on your device."
          lead="New fraud tactics are learned in the cloud. A tiny, private model ships to your browser."
          className="mb-16 lg:mb-20"
        />

        {/* Mobile Stage Stepper: Interactive tabs + swipeable focused active stage card */}
        <div className="block md:hidden">
          {/* Phase Switcher Tabs */}
          <div
            role="tablist"
            aria-label="Model training stages"
            className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-ink-900 p-1"
          >
            {STAGES.map((stage, idx) => {
              const Icon = stage.icon;
              const isActive = idx === activeStage;
              return (
                <button
                  key={stage.num}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleSelectStage(idx)}
                  className={cn(
                    "flex min-h-[46px] cursor-pointer flex-col items-center justify-center rounded-lg px-1 py-1 transition-all",
                    isActive
                      ? "bg-shield text-ink-950 font-bold shadow-md"
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px]">{stage.num}</span>
                    <Icon className="h-3 w-3" strokeWidth={2.2} />
                  </div>
                  <span className="text-[10px] font-medium truncate max-w-full">{stage.title}</span>
                </button>
              );
            })}
          </div>

          {/* Active Stage Card on Mobile with Touch Swipe */}
          <div
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="mt-4 rounded-2xl border border-white/10 bg-ink-900/80 p-5 shadow-lg select-none touch-pan-y"
          >
            <div className="flex items-start justify-between">
              <div>
                <span className="inline-block font-mono text-[11px] font-semibold uppercase tracking-wider text-shield">
                  Phase {STAGES[activeStage].num} · {STAGES[activeStage].tagline}
                </span>
                <h3 className="mt-1 font-display text-2xl font-bold text-white">
                  {STAGES[activeStage].title}
                </h3>
              </div>
              <span className="font-display text-5xl font-bold leading-none text-shield/25 [-webkit-text-stroke:1px_rgba(198,244,50,0.8)]">
                {STAGES[activeStage].num}
              </span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-white/75">
              {STAGES[activeStage].description}
            </p>

            <ul className="mt-4 space-y-1.5 border-t border-white/[0.08] pt-3 font-mono text-xs text-white/65">
              {STAGES[activeStage].specs.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="text-shield font-bold">–</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[11px] font-mono text-white/40">
              <div className="flex items-center gap-1">
                {STAGES.map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      i === activeStage ? "w-4 bg-shield" : "w-1.5 bg-white/20"
                    )}
                  />
                ))}
              </div>
              <span>Swipe left/right →</span>
            </div>
          </div>
        </div>

        {/* Desktop-Only 4-Column Grid */}
        <ol
          ref={stagesRef}
          className="reveal relative hidden md:grid md:grid-cols-2 md:gap-x-8 md:gap-y-16 md:border-t md:border-white/[0.08] md:pl-0 lg:grid-cols-4 lg:gap-y-0"
        >
          {STAGES.map((stage, idx) => {
            const Icon = stage.icon;
            const isActive = idx === activeStage;

            return (
              <li
                key={stage.num}
                onClick={() => handleSelectStage(idx)}
                className={cn(
                  "group relative cursor-pointer transition-all duration-300 md:pr-4 md:pt-10",
                  isActive ? "opacity-100" : "opacity-75 hover:opacity-100"
                )}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelectStage(idx);
                  }
                }}
                aria-label={`Inspect Stage ${stage.num}: ${stage.title}`}
              >
                <span
                  className={cn(
                    "absolute -top-[3px] left-0 h-1.5 w-1.5 rounded-full transition-all duration-300",
                    isActive
                      ? "bg-shield shadow-[0_0_10px_rgba(198,244,50,0.9)] scale-125"
                      : "bg-shield/50 group-hover:bg-shield"
                  )}
                />
                <div className="flex items-end justify-between">
                  <span
                    className={cn(
                      "font-display text-[5rem] font-bold leading-none transition-all duration-300",
                      isActive
                        ? "text-shield/20 [-webkit-text-stroke:1px_rgba(198,244,50,0.9)] drop-shadow-[0_0_15px_rgba(198,244,50,0.25)]"
                        : "text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,0.35)] group-hover:[-webkit-text-stroke:1px_rgba(255,255,255,0.6)]"
                    )}
                  >
                    {stage.num}
                  </span>
                  <Icon
                    className={cn(
                      "mb-2 h-6 w-6 transition-all duration-300",
                      isActive
                        ? "text-shield scale-110 drop-shadow-[0_0_8px_rgba(198,244,50,0.6)]"
                        : "text-shield/70 group-hover:text-shield"
                    )}
                    strokeWidth={2}
                  />
                </div>
                <h3
                  className={cn(
                    "mt-8 font-display text-[22px] font-bold leading-snug tracking-tight transition-colors",
                    isActive ? "text-white" : "text-white/85 group-hover:text-white"
                  )}
                >
                  {stage.title}
                </h3>
                <p className="mt-2 font-mono text-xs uppercase tracking-wider text-white/55">{stage.tagline}</p>
                <p className="mt-5 text-base leading-relaxed text-white/65">{stage.description}</p>
                <ul className="mt-6 space-y-2 font-mono text-[13px] text-white/60">
                  {stage.specs.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="text-shield">–</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                {/* Sublte vertical alignment beam connecting card to the pipeline track */}
                {isActive && (
                  <div
                    className="hidden lg:block absolute -bottom-8 left-1/2 -translate-x-1/2 h-8 w-px bg-gradient-to-b from-shield/80 to-shield/20 animate-pulse pointer-events-none"
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>

        {/* Connected 1-2-3-4 Pipeline Animation Track with Model Training Arrow */}
        <div className="mt-8 sm:mt-10">
          <LifecyclePipelineTrack
            activeStage={activeStage}
            onSelectStage={handleSelectStage}
            isPlaying={isPlaying}
            onTogglePlay={() => setIsPlaying((prev) => !prev)}
          />
        </div>

        <div className="mt-14 flex items-start gap-3 border-t border-white/[0.08] pt-8 font-mono text-sm text-white/60">
          <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-shield" strokeWidth={2} />
          <p>The loop never stops: newly reported threats join tomorrow&apos;s sweep.</p>
        </div>
      </div>
    </section>
  );
}

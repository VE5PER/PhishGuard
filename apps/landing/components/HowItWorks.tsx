"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { BrowserStage, type StageBeat } from "@/components/story/BrowserStage";
import { type ProductFacts } from "@/lib/facts";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useAutoScenes } from "@/lib/useAutoScenes";
import { useProductFacts } from "@/lib/useProductFacts";
import { useSceneInView } from "@/lib/useSceneInView";
import { cn } from "@/lib/utils";

const READ_MS_PER_WORD = 76;
const MIN_SCENE_MS = 3000;
const MAX_SCENE_MS = 7400;
const LOOP_SCENE_MS = 3000;

interface Beat {
  name: string;
  tagline: string;
  body: string;
  chips: string[];
}

const getBeats = (facts: ProductFacts): Beat[] => [
  {
    name: "Interaction",
    tagline: "How the page is being used",
    body: "Cursor speed, curve and jitter. Typing rhythm—never the keys. A paste into a password field. Human hands wobble; scripts move in perfect lines.",
    chips: ["Cursor path", "Typing rhythm", "Password paste"],
  },
  {
    name: "Page structure",
    tagline: "How the page is built",
    body: "Invisible overlays, password fields inside cross-origin frames, and look-alike domains like paypa1.xyz—checked live as the page changes.",
    chips: ["Hidden overlays", "Cross-origin frames", "Look-alike domains"],
  },
  {
    name: "Vision",
    tagline: "What the page looks like",
    body: `On pages that ask for a password, PhishGuard takes a ${facts.visionInput} glance at the visible tab and checks whether the logo and layout belong to the domain you're on. The thumbnail is used in memory and is never saved.`,
    chips: ["Logo vs domain", "Layout clone", `${facts.visionInput}, never stored`],
  },
  {
    name: "Verdict",
    tagline: "All three, fused",
    body: "The signals combine into one score. Under 0.15 passes silently. 0.15–0.85 is flagged in the toolbar. Over 0.85 freezes the page before anything leaks.",
    chips: ["Safe < 0.15", "Suspicious 0.15–0.85", "Blocked > 0.85"],
  },
  {
    name: "Cloud check",
    tagline: "An optional second opinion",
    body: `Borderline page? Ask for a second opinion from the toolbar. A Gemini agent built on Google ADK reviews the same three signals—interaction timing, page structure and, if you tick the box, a ${facts.screenshotUpload} screenshot—then checks the brand's official domains and past verdicts before it answers. Safety rails stop it from overruling hard evidence, and if Gemini is unavailable the gateway's own checks answer instead.`,
    chips: ["Only when you ask", "Gemini ADK agent", "Brand-domain check"],
  },
];

const countWords = (beat: Beat): number =>
  [beat.name, beat.tagline, beat.body, ...beat.chips].join(" ").split(/\s+/).filter(Boolean).length;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const LEAD =
  "PhishGuard watches how a page is used, how it's built, and what it looks like—then fuses all three into a single risk score, right in your browser. When a page is borderline, you can ask a Gemini agent for a second opinion.";

function Chips({ chips }: { chips: string[] }) {
  return (
    <ul className="mt-5 flex flex-wrap gap-2">
      {chips.map((chip) => (
        <li key={chip} className="rounded-full border border-white/[0.14] px-3 py-1.5 font-mono text-xs text-white/70">
          {chip}
        </li>
      ))}
    </ul>
  );
}

function ModelsLink() {
  return (
    <a href="#models" className="inline-flex items-center gap-2 font-mono text-sm text-shield hover:underline">
      See how our models learn
      <ArrowRight className="h-4 w-4" />
    </a>
  );
}

export function HowItWorks() {
  const facts = useProductFacts();
  const reducedMotion = usePrefersReducedMotion();
  const beats = useMemo(() => getBeats(facts), [facts]);
  const pacing = useMemo(
    () => ({
      firstPassMs: beats.map((beat) => clamp(countWords(beat) * READ_MS_PER_WORD, MIN_SCENE_MS, MAX_SCENE_MS)),
      loopMs: beats.map(() => LOOP_SCENE_MS),
    }),
    [beats]
  );
  const title = "Three signals. One verdict. On-device.";

  const [sectionRef, inView] = useSceneInView<HTMLElement>(0.35);
  const autoplay = inView && !reducedMotion;
  const [focused, setFocused] = useState(false);
  const { scene, goTo, cycle, durationMs, running, manual, finished } = useAutoScenes({
    ...pacing,
    enabled: autoplay,
    paused: focused,
  });

  return (
    <section
      id="how-it-works"
      data-page
      ref={sectionRef}
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      className="flex flex-col justify-center border-t border-white/[0.08] py-[clamp(5rem,8vw,7rem)] lg:min-h-[100svh]"
    >
      <div className="container-x grid grid-cols-1 gap-y-8 lg:grid-cols-12 lg:gap-x-8 lg:gap-y-0">
        <div className="lg:col-span-5 lg:row-start-1">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-4 font-display text-[clamp(1.75rem,min(3.4vw,5.2svh),2.75rem)] font-bold leading-[1.05] tracking-[-0.03em] text-white">
            {title}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-white/60">{LEAD}</p>

          {/* Mobile-Only Segmented Step Switcher (Placed above stage on mobile) */}
          <div className="mt-6 flex lg:hidden">
            <div
              role="tablist"
              aria-label="Detection signals"
              className="grid w-full grid-cols-6 gap-1 sm:grid-cols-5 rounded-xl border border-white/10 bg-ink-900 p-1"
            >
              {beats.map((b, i) => {
                const active = i === scene;
                return (
                  <button
                    key={b.name}
                    role="tab"
                    aria-selected={active}
                    onClick={() => goTo(i)}
                    className={cn(
                      "flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-1 font-mono text-[11px] sm:text-xs font-semibold transition-all",
                      i < 3 ? "col-span-2 sm:col-span-1" : "col-span-3 sm:col-span-1",
                      active
                        ? "bg-shield text-ink-950 shadow-sm"
                        : "text-white/55 hover:text-white"
                    )}
                  >
                    <span>{b.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Stage View: Equipped with touch swipe gestures */}
        <div className="lg:col-span-6 lg:col-start-7 lg:row-span-3 lg:row-start-1 lg:self-center">
          <BrowserStage
            beat={scene as StageBeat}
            running={autoplay}
            durationMs={manual ? pacing.loopMs[scene] : durationMs}
            onNextBeat={() => goTo((scene + 1) % beats.length)}
            onPrevBeat={() => goTo((scene - 1 + beats.length) % beats.length)}
          />

          {/* Mobile Touch Navigation Dots */}
          <div className="mt-3 flex lg:hidden items-center justify-between px-1">
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {beats.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Go to signal ${i + 1}`}
                  className={cn(
                    "h-2 rounded-full transition-all min-w-[8px]",
                    i === scene ? "w-6 bg-shield" : "w-2 bg-white/20 hover:bg-white/40"
                  )}
                />
              ))}
            </div>
            <span className="font-mono text-[11px] text-white/40">Swipe to explore →</span>
          </div>

          {/* Mobile description card right below stage */}
          <div className="mt-4 block lg:hidden rounded-xl border border-white/[0.08] bg-ink-900/60 p-4">
            <div className="flex items-baseline justify-between">
              <span className="font-display text-lg font-bold text-white">{beats[scene].name}</span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-shield">{beats[scene].tagline}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-white/75">{beats[scene].body}</p>
            <Chips chips={beats[scene].chips} />
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <ModelsLink />
            </div>
          </div>
        </div>

        {/* Desktop-Only Vertical Progress Buttons */}
        <div className="hidden border-t border-white/[0.08] lg:col-span-5 lg:row-start-2 lg:mt-6 lg:block">
          {beats.map((b, i) => {
            const active = i === scene;
            return (
              <button
                key={b.name}
                onClick={() => goTo(i)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "relative block w-full cursor-pointer border-b border-white/[0.08] py-2.5 pl-5 text-left transition-colors duration-200",
                  active ? "text-white" : "text-white/40 hover:text-white/70"
                )}
              >
                <span className="absolute bottom-0 left-0 top-0 w-0.5 bg-white/10">
                  {active && !reducedMotion && (manual || finished) && <span className="absolute inset-0 bg-shield" />}
                  {active && !reducedMotion && !manual && !finished && (
                    <span
                      key={`${i}-${cycle}`}
                      className="absolute inset-0 origin-top bg-shield"
                      style={{
                        animation: `scene-progress ${durationMs}ms linear forwards`,
                        animationPlayState: running ? "running" : "paused",
                      }}
                    />
                  )}
                </span>
                <span className="block font-display text-[20px] font-bold leading-snug tracking-tight">{b.name}</span>
                <span className="block font-mono text-xs uppercase tracking-wider">{b.tagline}</span>
              </button>
            );
          })}
        </div>

        {/* Desktop-Only Description Grid */}
        <div className="hidden lg:col-span-5 lg:row-start-3 lg:mt-6 lg:block">
          <div className="grid">
            {beats.map((b, i) => (
              <div
                key={b.name}
                aria-hidden={i !== scene}
                className={cn(
                  "col-start-1 row-start-1 transition-opacity duration-200",
                  i === scene ? "opacity-100" : "pointer-events-none opacity-0"
                )}
              >
                <p className="max-w-lg text-base leading-relaxed text-white/75">{b.body}</p>
                <Chips chips={b.chips} />
              </div>
            ))}
          </div>
          <div className="mt-6">
            <ModelsLink />
          </div>
        </div>
      </div>
    </section>
  );
}

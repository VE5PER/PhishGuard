"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { PopupReplica } from "@/components/replica/PopupReplica";
import { registerMeasure } from "@/lib/scrollBus";
import { getPopupStates, type PopupStateKey } from "@/lib/popupStates";
import { useAutoScenes } from "@/lib/useAutoScenes";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useProductFacts } from "@/lib/useProductFacts";
import { useSceneInView } from "@/lib/useSceneInView";
import { cn } from "@/lib/utils";

const STATES: { key: PopupStateKey; label: string; dot: string }[] = [
  { key: "safe", label: "Safe", dot: "bg-shield" },
  { key: "suspicious", label: "Suspicious", dot: "bg-alert" },
  { key: "blocked", label: "Blocked", dot: "bg-quarantine" },
];

const CAPTIONS = [
  "Most pages: nothing to see. No pop-ups, no network requests.",
  "Borderline pages get flagged, with every signal laid out. Ask the cloud for a second opinion if you want one.",
  "Dangerous pages are frozen behind a full-screen warning before you type a thing.",
];

const FIRST_PASS_MS = [3200, 3600, 3600];
const LOOP_MS = [3000, 3000, 3000];

const POPUP_WIDTH = 360;
const MAX_SCALE = 1.15;
const VERTICAL_MARGIN = 112;
const DESKTOP_MIN_WIDTH = 1024;

function ScaledPopup({
  stateIndex,
  onSwipeLeft,
  onSwipeRight,
}: {
  stateIndex: number;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const facts = useProductFacts();
  const states = useMemo(() => getPopupStates(facts), [facts]);
  const frameRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
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
        onSwipeLeft?.();
      } else {
        onSwipeRight?.();
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  useEffect(() => {
    const frame = frameRef.current;
    const popup = popupRef.current;
    if (!frame || !popup) return;

    const measure = () => {
      if (!popup.offsetHeight) return;
      const available = frame.parentElement?.clientWidth ?? POPUP_WIDTH;
      const fitWidth = Math.min(1, available / POPUP_WIDTH);
      const scale =
        window.innerWidth >= DESKTOP_MIN_WIDTH
          ? Math.min(MAX_SCALE, Math.max(0.5, (window.innerHeight - VERTICAL_MARGIN) / popup.offsetHeight), available / POPUP_WIDTH)
          : fitWidth;
      frame.style.width = `${POPUP_WIDTH * scale}px`;
      frame.style.height = `${popup.offsetHeight * scale}px`;
      popup.style.transform = `scale(${scale})`;
    };

    return registerMeasure(measure);
  }, []);

  return (
    <div
      ref={frameRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{ width: POPUP_WIDTH }}
      className="max-w-full overflow-hidden select-none touch-pan-y"
    >
      <div ref={popupRef} className="origin-top-left" style={{ width: POPUP_WIDTH }}>
        <PopupReplica state={states[STATES[stateIndex].key]} className="shadow-[0_24px_48px_-24px_rgba(0,0,0,0.6)]" />
      </div>
    </div>
  );
}

export function ExtensionShowcase() {
  const reducedMotion = usePrefersReducedMotion();
  const [sectionRef, inView] = useSceneInView<HTMLElement>(0.35);
  const [focused, setFocused] = useState(false);
  const autoplay = inView && !reducedMotion;
  const { scene, goTo, cycle, durationMs, running, manual, finished } = useAutoScenes({
    firstPassMs: FIRST_PASS_MS,
    loopMs: LOOP_MS,
    enabled: autoplay,
    paused: focused,
  });

  return (
    <section
      id="extension"
      ref={sectionRef}
      data-page
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      className="flex flex-col justify-center border-t border-white/[0.08] py-[clamp(5rem,8vw,7rem)] lg:min-h-[100svh]"
    >
      <div className="container-x grid grid-cols-1 gap-y-8 lg:grid-cols-12 lg:gap-x-8 lg:gap-y-0">
        <div className="lg:col-span-5 lg:row-start-1">
          <p className="eyebrow">The extension</p>
          <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em] text-white">
            Quiet until it isn&apos;t.
          </h2>
          <p className="mt-6 text-[17px] leading-relaxed text-white/60">
            One glance at the toolbar tells you what PhishGuard saw—and why.
          </p>

          {/* Mobile-Only Segmented Pill Switcher (Placed above preview on mobile) */}
          <div className="mt-6 flex lg:hidden">
            <div
              role="tablist"
              aria-label="Extension states"
              className="grid w-full grid-cols-3 gap-1 rounded-xl border border-white/10 bg-ink-900 p-1"
            >
              {STATES.map((state, i) => {
                const active = i === scene;
                return (
                  <button
                    key={state.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => goTo(i)}
                    className={cn(
                      "flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg px-2 font-mono text-xs font-semibold transition-all",
                      active
                        ? "bg-ink-700 text-white shadow-sm ring-1 ring-white/15"
                        : "text-white/55 hover:text-white"
                    )}
                  >
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", state.dot)} />
                    <span>{state.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Extension Popup Replica View with Touch Swipe */}
        <div className="flex flex-col items-center justify-center lg:col-span-6 lg:col-start-7 lg:row-span-3 lg:row-start-1 lg:self-center">
          <ScaledPopup
            stateIndex={scene}
            onSwipeLeft={() => goTo((scene + 1) % STATES.length)}
            onSwipeRight={() => goTo((scene - 1 + STATES.length) % STATES.length)}
          />

          {/* Mobile Dot Navigation & Caption */}
          <div className="mt-4 flex w-full max-w-[360px] flex-col gap-3 lg:hidden">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                {STATES.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => goTo(i)}
                    aria-label={`Go to state ${STATES[i].label}`}
                    className={cn(
                      "h-2 rounded-full transition-all min-w-[8px]",
                      i === scene ? "w-6 bg-shield" : "w-2 bg-white/20 hover:bg-white/40"
                    )}
                  />
                ))}
              </div>
              <span className="font-mono text-[11px] text-white/40">Swipe to switch →</span>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-ink-900/60 p-4">
              <div className="flex items-center gap-2">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", STATES[scene].dot)} />
                <span className="font-display text-base font-bold text-white">{STATES[scene].label} State</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-white/75">{CAPTIONS[scene]}</p>
              <div className="mt-3">
                <a
                  href={`/sample${scene + 1}`}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-shield hover:underline"
                >
                  <span>Launch Live Trigger: Sample {scene + 1} &rarr;</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Desktop-Only State Buttons */}
        <div className="hidden border-t border-white/[0.08] lg:col-span-5 lg:row-start-2 lg:mt-8 lg:block">
          {STATES.map((state, i) => {
            const active = i === scene;
            return (
              <button
                key={state.key}
                onClick={() => goTo(i)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "relative flex w-full cursor-pointer items-center gap-3 border-b border-white/[0.08] py-3 pl-5 text-left transition-colors duration-200",
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
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", state.dot)} />
                <span className="font-display text-[20px] font-bold leading-snug tracking-tight">{state.label}</span>
              </button>
            );
          })}
        </div>

        {/* Desktop-Only Captions */}
        <div className="hidden grid lg:col-span-5 lg:row-start-3 lg:mt-6 lg:grid">
          {CAPTIONS.map((caption, i) => (
            <div
              key={caption}
              aria-hidden={i !== scene}
              className={cn(
                "col-start-1 row-start-1 max-w-md border-l-2 border-shield pl-5 transition-opacity duration-200",
                i === scene ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              <p className="text-lg leading-relaxed text-white">{caption}</p>
              <div className="mt-4">
                <a
                  href={`/sample${i + 1}`}
                  className="inline-flex items-center gap-2 rounded-full border border-shield/40 bg-shield/10 px-4 py-2 text-xs font-bold text-shield transition-all hover:bg-shield/20 hover:border-shield"
                >
                  <span>Launch Live Trigger: Sample {i + 1} &rarr;</span>
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

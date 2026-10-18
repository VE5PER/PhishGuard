"use client";

import React from "react";
import { StatsStrip } from "@/components/StatsStrip";
import { useSceneInView } from "@/lib/useSceneInView";

const STATEMENT = "A phishing page takes minutes to build. A blocklist takes days to catch it. An AI agent won't hesitate at all.";
const FOLLOW_UP = "So PhishGuard doesn't wait for a list. It reads the page itself—on your device—before a bank login is lost.";

const WORDS = STATEMENT.split(" ");
const WORD_STAGGER_MS = 35;
const FOLLOW_UP_DELAY_MS = WORDS.length * WORD_STAGGER_MS + 200;
const STATS_DELAY_MS = FOLLOW_UP_DELAY_MS + 100;

export function WhyStatement() {
  const [ref, active] = useSceneInView<HTMLElement>(0.4);

  return (
    <section
      id="why"
      data-page
      ref={ref}
      data-scene
      data-active={active}
      className="relative isolate flex flex-col justify-center overflow-hidden border-t border-white/[0.08] py-[clamp(5rem,8vw,8rem)] lg:min-h-[100svh]"
    >
      <div className="pointer-events-none absolute -bottom-72 -right-72 -z-10 h-[900px] w-[900px] bg-[radial-gradient(closest-side,rgba(198,244,50,0.07),transparent)]" />
      <div className="container-x">
        <p className="eyebrow">Why PhishGuard</p>
        <p className="mt-6 max-w-5xl font-display text-[clamp(2rem,4.5vw,4rem)] font-bold leading-[1.1] tracking-[-0.03em] text-white">
          {WORDS.map((word, i) => (
            <span key={i} data-anim="fade" style={{ "--d": `${i * WORD_STAGGER_MS}ms` } as React.CSSProperties}>
              {word}{" "}
            </span>
          ))}
        </p>
        <p
          data-anim
          className="mt-8 max-w-2xl text-lg leading-relaxed text-white/70 lg:text-xl"
          style={{ "--d": `${FOLLOW_UP_DELAY_MS}ms` } as React.CSSProperties}
        >
          {FOLLOW_UP}
        </p>
        <div className="mt-16 lg:mt-20">
          <StatsStrip baseDelayMs={STATS_DELAY_MS} />
        </div>
      </div>
    </section>
  );
}

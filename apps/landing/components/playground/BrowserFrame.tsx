"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Lock, RotateCw, Shield } from "lucide-react";
import type { PlaygroundScenario } from "@phishguard/types";
import { BlockOverlayReplica } from "@/components/replica/BlockOverlayReplica";
import { WarnBannerReplica } from "@/components/replica/WarnBannerReplica";
import type { EdgeRoute } from "@/lib/playground/demoResults";
import { cn } from "@/lib/utils";

const PAGE_WIDTH = 1024;
const PAGE_HEIGHT = 640;
const MIN_REPLAY_MS = 1500;

const EXTENSION_TONE: Record<EdgeRoute | "none", string> = {
  none: "text-white/50 border-white/20",
  SAFE: "text-shield border-shield/60 bg-shield/10",
  AMBIGUOUS: "text-alert border-alert/60 bg-alert/10",
  BLOCK: "text-quarantine border-quarantine/60 bg-quarantine/10",
};

interface BrowserFrameProps {
  scenario: PlaygroundScenario;
  trajectory: PlaygroundScenario["payload"]["mouseTrajectorySeries"];
  edgeRoute: EdgeRoute | null;
  replayToken: number;
  replaying: boolean;
  reducedMotion: boolean;
  onReplayDone: () => void;
  blockOverlay: { brand: string | null; reasons: string[] } | null;
  warnBanner: { brand: string | null; reason: string | null } | null;
  onLeave: () => void;
  onIgnore: () => void;
  onDismissWarning: () => void;
}

export function BrowserFrame({
  scenario,
  trajectory,
  edgeRoute,
  replayToken,
  replaying,
  reducedMotion,
  onReplayDone,
  blockOverlay,
  warnBanner,
  onLeave,
  onIgnore,
  onDismissWarning,
}: BrowserFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef(onReplayDone);
  doneRef.current = onReplayDone;
  const [scale, setScale] = useState(0.6);
  const [pageTitle, setPageTitle] = useState("");

  const url = new URL(scenario.payload.url);
  const path = `${url.pathname}${url.search}`;

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const update = () => setScale(node.clientWidth / PAGE_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPageTitle("");
  }, [scenario.id]);

  useEffect(() => {
    const cursor = cursorRef.current;
    if (!cursor || trajectory.length === 0) return;
    const place = (index: number) => {
      cursor.style.left = `${trajectory[index].x * 100}%`;
      cursor.style.top = `${trajectory[index].y * 100}%`;
    };
    if (!replaying) {
      cursor.style.opacity = "0";
      return;
    }
    cursor.style.opacity = "1";
    if (reducedMotion) {
      place(trajectory.length - 1);
      doneRef.current();
      return;
    }
    const trajectoryMs = trajectory[trajectory.length - 1].timestamp - trajectory[0].timestamp;
    const duration = Math.max(trajectoryMs, MIN_REPLAY_MS);
    const factor = trajectoryMs > 0 ? trajectoryMs / duration : 1;
    const startAt = performance.now();
    let frame = 0;
    let index = 0;
    const tick = (now: number) => {
      const elapsed = now - startAt;
      const target = trajectory[0].timestamp + elapsed * factor;
      while (index < trajectory.length - 1 && trajectory[index + 1].timestamp <= target) index++;
      place(index);
      if (elapsed >= duration) {
        place(trajectory.length - 1);
        doneRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    place(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [trajectory, replaying, reducedMotion, replayToken]);

  const layerStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    transform: `scale(${scale})`,
    transformOrigin: "0 0",
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-ink-800 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]">
      <div className="flex items-end gap-3 bg-ink-850 px-3 pt-2.5">
        <span className="mb-2.5 flex shrink-0 gap-1.5" aria-hidden="true">
          <i className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <i className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <i className="h-3 w-3 rounded-full bg-[#28c840]" />
        </span>
        <div className="flex min-w-0 max-w-[260px] items-center gap-2 rounded-t-lg bg-ink-800 px-3 py-2">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white/20 font-mono text-[10px] font-bold uppercase text-white">
            {(pageTitle || scenario.title).charAt(0)}
          </span>
          <span className="truncate text-xs text-white/80" data-testid="tab-title">
            {pageTitle || "Loading…"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-white/[0.08] bg-ink-800 px-3 py-2">
        <ArrowLeft className="h-4 w-4 shrink-0 text-white/35" />
        <ArrowRight className="h-4 w-4 shrink-0 text-white/35" />
        <RotateCw className="h-4 w-4 shrink-0 text-white/55" />
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-ink-950 px-3 py-1.5 font-mono text-xs">
          <Lock className="h-3 w-3 shrink-0 text-white/50" />
          <span className="min-w-0 truncate">
            <span className="text-white">{url.hostname}</span>
            <span className="text-white/40">{path}</span>
          </span>
        </div>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors duration-500",
            EXTENSION_TONE[edgeRoute ?? "none"],
          )}
          title={`PhishGuard${edgeRoute ? `: ${edgeRoute}` : ""}`}
          data-testid="extension-icon"
          data-route={edgeRoute ?? "none"}
        >
          <Shield className="h-3.5 w-3.5" strokeWidth={2.2} />
        </span>
      </div>
      <div ref={wrapperRef} className="relative w-full overflow-hidden bg-white" style={{ height: PAGE_HEIGHT * scale }}>
        <iframe
          key={scenario.id}
          title={scenario.title}
          src={`/sandbox/${scenario.id}.html`}
          scrolling="no"
          tabIndex={-1}
          onLoad={(event) => {
            setPageTitle(event.currentTarget.contentDocument?.title ?? "");
          }}
          style={{
            ...layerStyle,
            border: 0,
            background: "#fff",
            pointerEvents: "none",
          }}
        />
        <span
            ref={cursorRef}
            aria-hidden="true"
            className={cn("pointer-events-none absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-shield opacity-0 shadow-[0_0_0_4px_rgba(198,244,50,0.25)]", (blockOverlay || warnBanner) && "invisible")}
        />
        {warnBanner ? (
          <div style={{ ...layerStyle, pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto" }}>
              <WarnBannerReplica
                brand={warnBanner.brand}
                hostname={url.hostname}
                reason={warnBanner.reason}
                onLeave={onLeave}
                onDismiss={onDismissWarning}
              />
            </div>
          </div>
        ) : null}
        {blockOverlay ? (
          <div style={layerStyle} data-testid="block-overlay">
            <BlockOverlayReplica brand={blockOverlay.brand} reasons={blockOverlay.reasons} onLeave={onLeave} onIgnore={onIgnore} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

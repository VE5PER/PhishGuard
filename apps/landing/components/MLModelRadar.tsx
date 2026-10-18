"use client";

import React, { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";

// --- Curated detection telemetry for randomly spawned blips ---
interface BlipTelemetryTemplate {
  kind: "safe" | "threat" | "alert";
  label: string;
  sublabel: string;
  color: string;
}

const TELEMETRY_TEMPLATES: BlipTelemetryTemplate[] = [
  { kind: "safe", label: "KINEMATICS · 0.04", sublabel: "NATURAL", color: "#C6F432" },
  { kind: "safe", label: "DOM TREE · CLEAN", sublabel: "0 TRAPS", color: "#C6F432" },
  { kind: "safe", label: "INT8 WEBGPU", sublabel: "ON-DEVICE", color: "#C6F432" },
  { kind: "safe", label: "SAFE · 0.02", sublabel: "CALIBRATED", color: "#C6F432" },
  { kind: "safe", label: "POINTER JITTER", sublabel: "0.08 LOW", color: "#C6F432" },
  { kind: "safe", label: "TIMING RHYTHM", sublabel: "142px/s", color: "#C6F432" },
  { kind: "threat", label: "BLOCKED · 0.94", sublabel: "IMPERSONATION", color: "#FF5A46" },
  { kind: "threat", label: "OPACITY: 0 TRAP", sublabel: "HIDDEN OVERLAY", color: "#FF5A46" },
  { kind: "threat", label: "PAYPA1.XYZ", sublabel: "LOOK-ALIKE", color: "#FF5A46" },
  { kind: "threat", label: "BOT SCRIPTED", sublabel: "3,400px/s", color: "#FF5A46" },
  { kind: "alert", label: "CROSS-ORIGIN", sublabel: "PASSWORD FRAME", color: "#FFB224" },
  { kind: "alert", label: "CLONE MATCH", sublabel: "SIMILARITY 0.97", color: "#FFB224" },
];

interface ActiveBlip {
  angle: number; // in radians [0, 2*PI)
  r: number; // distance from core
  kind: "safe" | "threat" | "alert";
  label: string;
  sublabel: string;
  color: string;
  caught: boolean;
  caughtTime: number;
  durationMs: number;
}

const SWEEP_PERIOD_MS = 6000; // 6.0 seconds per graceful 360° rotation
const MAX_ACTIVE_BLIPS = 1; // Ultra-low frequency: only 1 blip at a time with cooldowns between detections

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function spawnBlip(currentAngle: number, maxRadius: number, isSmallScreen = false): ActiveBlip {
  const tpl = TELEMETRY_TEMPLATES[Math.floor(Math.random() * TELEMETRY_TEMPLATES.length)];
  // Spawn well ahead of the sweep for serene, spaced-out detection pacing
  const aheadOffset = rand(0.9, Math.PI * 1.7);
  const angle = (currentAngle + aheadOffset) % (Math.PI * 2);
  const minR = isSmallScreen ? 60 : 90;
  const maxR = isSmallScreen ? Math.min(160, Math.max(90, maxRadius * 0.5)) : Math.max(140, maxRadius * 0.75);
  const r = rand(minR, maxR);

  return {
    angle,
    r,
    kind: tpl.kind,
    label: tpl.label,
    sublabel: tpl.sublabel,
    color: tpl.color,
    caught: false,
    caughtTime: 0,
    durationMs: rand(2200, 2800),
  };
}

/**
 * ScreenRadarOverlay
 * Renders a dynamic, screen-spanning 360° radar sweep and randomly caught blips.
 * Anchors the radar origin directly to the center of the singular ML Model Entity.
 */
export function ScreenRadarOverlay({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId = 0;
    let width = 0;
    let height = 0;
    let maxR = 0;
    let coreX = 0;
    let coreY = 0;
    let inView = true;

    let sweepAngle = 0;
    let lastTime = performance.now();
    let blips: ActiveBlip[] = [];
    let nextSpawnTime = performance.now() + 1800; // Peaceful initial delay before first blip spawns

    const updateCorePosition = () => {
      const coreEl = document.getElementById("ml-model-core");
      if (coreEl && canvas) {
        const rect = coreEl.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        coreX = rect.left + rect.width / 2 - canvasRect.left;
        coreY = rect.top + rect.height / 2 - canvasRect.top;
      } else {
        coreX = width / 2;
        coreY = height * 0.45;
      }

      // Max radius to fully span any screen corner
      const d1 = Math.hypot(coreX, coreY);
      const d2 = Math.hypot(width - coreX, coreY);
      const d3 = Math.hypot(coreX, height - coreY);
      const d4 = Math.hypot(width - coreX, height - coreY);
      maxR = Math.max(d1, d2, d3, d4, 300);
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      updateCorePosition();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent);
    resize();

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      updateCorePosition();

      // Static concentric rings
      const rings = [100, 220, 380, 580, 820];
      for (const r of rings) {
        if (r > maxR) break;
        ctx.beginPath();
        ctx.arc(coreX, coreY, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Static sweep beam at 45°
      const staticA = Math.PI * 0.25;
      ctx.beginPath();
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(coreX + maxR * Math.cos(staticA), coreY + maxR * Math.sin(staticA));
      ctx.strokeStyle = "rgba(198, 244, 50, 0.20)";
      ctx.lineWidth = 1.0;
      ctx.stroke();
    };

    if (reducedMotion) {
      drawStatic();
      return () => resizeObserver.disconnect();
    }

    const render = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;

      // Update core position (tracks responsive layout adjustments)
      updateCorePosition();

      // Advance sweep angle clockwise
      const prevAngle = sweepAngle;
      sweepAngle = (sweepAngle + (dt / SWEEP_PERIOD_MS) * (Math.PI * 2)) % (Math.PI * 2);

      ctx.clearRect(0, 0, width, height);

      // 1. Draw Concentric Radar Distance Rings across the entire screen
      const ringSteps = [80, 160, 260, 400, 580, 800, 1080, 1420, 1850];
      for (let i = 0; i < ringSteps.length; i++) {
        const r = ringSteps[i];
        if (r > maxR) break;

        ctx.beginPath();
        ctx.arc(coreX, coreY, r, 0, Math.PI * 2);

        if (i === 1) {
          // Calibrated Safe Threshold Ring (0.15)
          ctx.strokeStyle = "rgba(198, 244, 50, 0.08)";
          ctx.setLineDash([3, 4]);
        } else if (i === 3) {
          // Calibrated Block Threshold Ring (0.85)
          ctx.strokeStyle = "rgba(255, 90, 70, 0.06)";
          ctx.setLineDash([4, 6]);
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.022)";
          ctx.setLineDash([]);
        }

        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 2. Draw Crosshairs through the core
      ctx.beginPath();
      ctx.moveTo(coreX - maxR, coreY);
      ctx.lineTo(coreX + maxR, coreY);
      ctx.moveTo(coreX, coreY - maxR);
      ctx.lineTo(coreX, coreY + maxR);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.02)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // 3. Draw 360° Radar Sweep Phosphor Trailing Fan (Whisper light & subtle)
      const coneAngle = Math.PI * 0.12; // ~22° fan
      const slices = 10;
      for (let s = 0; s < slices; s++) {
        const sliceStart = sweepAngle - coneAngle * (1 - s / slices);
        const sliceEnd = sweepAngle - coneAngle * (1 - (s + 1) / slices);
        const alpha = Math.pow((s + 1) / slices, 3.0) * 0.022;

        ctx.beginPath();
        ctx.moveTo(coreX, coreY);
        ctx.arc(coreX, coreY, maxR, sliceStart, sliceEnd);
        ctx.closePath();
        ctx.fillStyle = `rgba(198, 244, 50, ${alpha})`;
        ctx.fill();
      }

      // 4. Draw Leading Radar Sweep Line (Ultra-light hairline beam)
      const leadX = coreX + maxR * Math.cos(sweepAngle);
      const leadY = coreY + maxR * Math.sin(sweepAngle);

      ctx.beginPath();
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(leadX, leadY);
      ctx.strokeStyle = "rgba(198, 244, 50, 0.22)";
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // 5. Update and Draw Dynamic Detection Blips
      // Ultra-low frequency: at most 1 active blip, with a 4.5-7.5s calm cooldown between detections
      const isSmall = width < 640;
      if (blips.length < MAX_ACTIVE_BLIPS && now >= nextSpawnTime) {
        blips.push(spawnBlip(sweepAngle, maxR, isSmall));
      }

      for (let i = 0; i < blips.length; i++) {
        const b = blips[i];

        if (!b.caught) {
          // Check if sweep beam crossed blip angle during this frame
          const crossed =
            prevAngle < sweepAngle
              ? b.angle >= prevAngle && b.angle <= sweepAngle
              : b.angle >= prevAngle || b.angle <= sweepAngle;

          if (crossed) {
            b.caught = true;
            b.caughtTime = now;
          }
        }
      }

      // Render blips
      const fontMono = isSmall ? "500 7.5px monospace" : "500 8.5px monospace";
      ctx.font = fontMono;

      for (let i = blips.length - 1; i >= 0; i--) {
        const b = blips[i];
        const bx = coreX + b.r * Math.cos(b.angle);
        const by = coreY + b.r * Math.sin(b.angle);

        // Keep blip within viewport bounds (protecting mobile screens from tag clipping)
        const marginX = isSmall ? 85 : 110;
        if (bx < 15 || bx > width - marginX || by < 40 || by > height - 50) {
          blips.splice(i, 1);
          nextSpawnTime = now + rand(3000, 5000);
          continue;
        }

        if (b.caught) {
          const age = now - b.caughtTime;

          if (age > b.durationMs) {
            // Expired: enter a calm cooldown before next blip appears
            blips.splice(i, 1);
            nextSpawnTime = now + rand(4500, 7500);
            continue;
          }

          const progress = age / b.durationMs;
          const phosphorFade = Math.max(0, 1 - Math.pow(progress, 1.4));

          // Expanding Sonar Ping Ring (Whisper subtle)
          const pingDuration = 600;
          if (age < pingDuration) {
            const pingProg = age / pingDuration;
            const pingRadius = (isSmall ? 18 : 24) * pingProg;
            const pingAlpha = (1 - pingProg) * 0.35;

            ctx.beginPath();
            ctx.arc(bx, by, pingRadius, 0, Math.PI * 2);
            ctx.strokeStyle =
              b.kind === "threat"
                ? `rgba(255, 90, 70, ${pingAlpha})`
                : b.kind === "alert"
                ? `rgba(255, 178, 36, ${pingAlpha})`
                : `rgba(198, 244, 50, ${pingAlpha})`;
            ctx.lineWidth = 0.75;
            ctx.stroke();
          }

          // Blip Core Point
          ctx.save();
          ctx.beginPath();
          ctx.arc(bx, by, isSmall ? 1.8 : 2, 0, Math.PI * 2);
          ctx.fillStyle = b.color;
          ctx.globalAlpha = phosphorFade * 0.85;
          ctx.shadowColor = b.color;
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.restore();

          // Monospace Detection Chip
          ctx.save();
          ctx.globalAlpha = Math.max(0, phosphorFade * 0.85);

          const tagText = `${b.label} · ${b.sublabel}`;
          const metrics = ctx.measureText(tagText);
          const tagW = metrics.width + (isSmall ? 6 : 8);
          const tagH = isSmall ? 12 : 14;
          const tagX = bx + 5;
          const tagY = by - tagH / 2;

          // Chip background
          ctx.fillStyle = "rgba(8, 9, 10, 0.88)";
          ctx.fillRect(tagX, tagY, tagW, tagH);

          // Chip border
          ctx.strokeStyle =
            b.kind === "threat"
              ? "rgba(255, 90, 70, 0.35)"
              : b.kind === "alert"
              ? "rgba(255, 178, 36, 0.35)"
              : "rgba(198, 244, 50, 0.3)";
          ctx.lineWidth = 0.8;
          ctx.strokeRect(tagX, tagY, tagW, tagH);

          // Chip text
          ctx.fillStyle = b.color;
          ctx.fillText(tagText, tagX + 3, tagY + (isSmall ? 8.5 : 10));
          ctx.restore();
        }
      }

      if (inView && !document.hidden) {
        animId = requestAnimationFrame(render);
      }
    };

    const start = () => {
      if (reducedMotion || !inView || document.hidden || animId) return;
      lastTime = performance.now();
      animId = requestAnimationFrame(render);
    };

    const stop = () => {
      if (animId) cancelAnimationFrame(animId);
      animId = 0;
    };

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) start();
      else stop();
    });
    intersectionObserver.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      aria-hidden="true"
    />
  );
}

/**
 * MLModelRadar
 * The singular on-device ML model entity.
 * Sits in the designated hero slot between the headline and hero copy.
 * Anchors the screen-wide radar sweep at its physical center.
 */
export function MLModelRadar({ className }: { className?: string }) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div
      id="ml-model-core"
      className={cn(
        "relative flex select-none flex-col items-center justify-center py-1",
        className
      )}
      aria-label="PhishGuard on-device ML model neural core"
    >
      {/* Outer ambient glow */}
      <div
        className="pointer-events-none absolute h-24 w-24 sm:h-32 sm:w-32 lg:h-36 lg:w-36 rounded-full bg-[radial-gradient(circle,rgba(198,244,50,0.15)_0%,transparent_70%)] blur-xl"
        aria-hidden="true"
      />

      {/* Singular Neural Core Entity */}
      <div className="relative flex h-12 w-12 sm:h-16 sm:w-16 lg:h-20 lg:w-20 items-center justify-center rounded-full border border-shield/40 bg-ink-950/90 shadow-[0_0_20px_rgba(198,244,50,0.2)] backdrop-blur-md">
        {/* Subtle spinning reticle ring */}
        <div
          className="pointer-events-none absolute inset-1 rounded-full border border-dashed border-shield/30"
          style={{
            animation: !reducedMotion ? "spin 16s linear infinite" : undefined,
          }}
        />

        {/* Neural network graph nodes icon */}
        <svg
          viewBox="0 0 32 32"
          className="relative h-6 w-6 sm:h-8 sm:w-8 lg:h-9 lg:w-9"
          fill="none"
          aria-hidden="true"
        >
          {/* Interconnect synapses */}
          <line x1="16" y1="16" x2="8" y2="8" stroke="#C6F432" strokeWidth="1.2" strokeOpacity="0.5" />
          <line x1="16" y1="16" x2="24" y2="8" stroke="#C6F432" strokeWidth="1.2" strokeOpacity="0.5" />
          <line x1="16" y1="16" x2="8" y2="24" stroke="#C6F432" strokeWidth="1.2" strokeOpacity="0.5" />
          <line x1="16" y1="16" x2="24" y2="24" stroke="#C6F432" strokeWidth="1.2" strokeOpacity="0.5" />

          {/* Satellite nodes */}
          <circle cx="8" cy="8" r="2" fill="#C6F432" fillOpacity="0.8" />
          <circle cx="24" cy="8" r="2" fill="#C6F432" fillOpacity="0.8" />
          <circle cx="8" cy="24" r="2" fill="#C6F432" fillOpacity="0.8" />
          <circle cx="24" cy="24" r="2" fill="#C6F432" fillOpacity="0.8" />

          {/* Central nucleus node */}
          <circle cx="16" cy="16" r="3.4" fill="#C6F432" className="animate-pulse" />
          <circle cx="16" cy="16" r="5.6" stroke="#C6F432" strokeWidth="0.8" strokeOpacity="0.6" />
        </svg>
      </div>
    </div>
  );
}

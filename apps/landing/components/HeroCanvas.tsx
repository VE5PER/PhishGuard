"use client";

import React, { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

interface Point {
  x: number;
  y: number;
}

interface OrganicTrail {
  kind: "organic";
  born: number;
  duration: number;
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

interface RoboticTrail {
  kind: "robotic";
  born: number;
  duration: number;
  from: Point;
  to: Point;
  score: string;
}

type Trail = OrganicTrail | RoboticTrail;

const LIME = "198,244,50";
const RED = "255,90,70";
const GRID_STEP = 32;
const SPAWN_INTERVAL_MS = 450;
const CAUGHT_AT = 0.65;
const HOLD_MS = 1200;
const ROBOTIC_FADE_MS = 600;
const ORGANIC_FADE_MS = 1000;
const FRAME_INTERVAL_MS = 33;
const DPR = 1;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function bezier(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function createOrganic(w: number, h: number, born: number): OrganicTrail {
  const fromLeft = Math.random() < 0.5;
  const p0 = fromLeft ? { x: rand(-0.02, 0.12) * w, y: rand(0.25, 0.95) * h } : { x: rand(0, 0.5) * w, y: rand(0.88, 1.02) * h };
  const p3 = { x: rand(0.5, 1) * w, y: rand(0.05, 0.8) * h };
  return {
    kind: "organic",
    born,
    duration: rand(3000, 5000),
    p0,
    p1: { x: rand(0.1, 0.6) * w, y: rand(0, 1) * h },
    p2: { x: rand(0.4, 0.95) * w, y: rand(0, 1) * h },
    p3,
  };
}

function createRobotic(w: number, h: number, born: number): RoboticTrail {
  const from = { x: rand(0, 0.4) * w, y: rand(0.1, 0.9) * h };
  const to = { x: from.x + rand(0.4, 0.6) * w, y: from.y + rand(-0.15, 0.15) * h };
  return {
    kind: "robotic",
    born,
    duration: rand(900, 1400),
    from,
    to,
    score: rand(0.86, 0.99).toFixed(2),
  };
}

function renderGrid(w: number, h: number, dpr: number): HTMLCanvasElement {
  const grid = document.createElement("canvas");
  grid.width = w * dpr;
  grid.height = h * dpr;
  const gctx = grid.getContext("2d");
  if (gctx) {
    gctx.scale(dpr, dpr);
    gctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let x = GRID_STEP / 2; x < w; x += GRID_STEP) {
      for (let y = GRID_STEP / 2; y < h; y += GRID_STEP) {
        gctx.fillRect(x, y, 1, 1);
      }
    }
  }
  return grid;
}

function drawOrganic(ctx: CanvasRenderingContext2D, trail: OrganicTrail, age: number) {
  const t = Math.min(age / trail.duration, 1);
  const fade = age > trail.duration ? 1 - (age - trail.duration) / ORGANIC_FADE_MS : 1;
  if (fade <= 0) return;

  const { p0, p1, p2, p3 } = trail;
  const samples = 40;
  ctx.beginPath();
  for (let i = 0; i <= samples; i++) {
    const st = (i / samples) * t;
    const x = bezier(st, p0.x, p1.x, p2.x, p3.x);
    const y = bezier(st, p0.y, p1.y, p2.y, p3.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(${LIME},${0.35 * fade})`;
  ctx.stroke();

  const hx = bezier(t, p0.x, p1.x, p2.x, p3.x);
  const hy = bezier(t, p0.y, p1.y, p2.y, p3.y);
  ctx.fillStyle = `rgba(${LIME},${fade})`;
  ctx.beginPath();
  ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawRobotic(ctx: CanvasRenderingContext2D, trail: RoboticTrail, age: number) {
  const raw = age / trail.duration;
  const t = Math.min(raw, CAUGHT_AT);
  const frozenAge = age - CAUGHT_AT * trail.duration;
  let fade = 1;
  if (frozenAge > HOLD_MS) fade = 1 - (frozenAge - HOLD_MS) / ROBOTIC_FADE_MS;
  if (fade <= 0) return;

  const hx = trail.from.x + (trail.to.x - trail.from.x) * t;
  const hy = trail.from.y + (trail.to.y - trail.from.y) * t;

  ctx.beginPath();
  ctx.moveTo(trail.from.x, trail.from.y);
  ctx.lineTo(hx, hy);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(${RED},${0.85 * fade})`;
  ctx.stroke();

  ctx.fillStyle = `rgba(${RED},${fade})`;
  ctx.beginPath();
  ctx.arc(hx, hy, 3, 0, Math.PI * 2);
  ctx.fill();

  if (frozenAge >= 0) {
    const b = 14;
    const l = 6;
    ctx.strokeStyle = `rgba(${RED},${fade})`;
    ctx.lineWidth = 1.5;
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [sx, sy] of corners) {
      const cx = hx + sx * b;
      const cy = hy + sy * b;
      ctx.beginPath();
      ctx.moveTo(cx - sx * l, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy - sy * l);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${RED},${fade})`;
    ctx.fillText(`BLOCKED · ${trail.score}`, hx + b + 8, hy - b - 4);
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  grid: HTMLCanvasElement | null,
  w: number,
  h: number,
  trails: Trail[],
  now: number,
  monoFamily: string
) {
  ctx.clearRect(0, 0, w, h);
  if (grid) ctx.drawImage(grid, 0, 0, w, h);
  ctx.font = `500 11px ${monoFamily}`;
  for (const trail of trails) {
    const age = now - trail.born;
    if (age < 0) continue;
    if (trail.kind === "organic") drawOrganic(ctx, trail, age);
    else drawRobotic(ctx, trail, age);
  }
}

function isExpired(trail: Trail, now: number): boolean {
  const age = now - trail.born;
  if (trail.kind === "organic") return age > trail.duration + ORGANIC_FADE_MS;
  return age > trail.duration * CAUGHT_AT + HOLD_MS + ROBOTIC_FADE_MS;
}

export function HeroCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const monoFamily = `${getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace"}, monospace`;

    let width = 0;
    let height = 0;
    let trails: Trail[] = [];
    let lastSpawn = 0;
    let lastDraw = 0;
    let frame = 0;
    let inView = true;
    let grid: HTMLCanvasElement | null = null;

    const staticFrame = () => {
      trails = [];
      for (let i = 0; i < 4; i++) {
        const trail = createOrganic(width, height, 0);
        trail.duration = 1000;
        trails.push(trail);
      }
      const robotic = createRobotic(width, height, 0);
      trails.push(robotic);
      const holdAt = robotic.duration * CAUGHT_AT + 300;
      drawFrame(ctx, grid, width, height, trails.map((t) => ({ ...t, born: t.kind === "organic" ? -1200 : -holdAt })), 0, monoFamily);
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = DPR;
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grid = renderGrid(width, height, dpr);
      if (reducedMotion) staticFrame();
    };

    const maxTrails = () => (width < 640 ? 6 : 12);

    const tick = (now: number) => {
      frame = 0;
      if (now - lastDraw < FRAME_INTERVAL_MS) {
        start();
        return;
      }
      lastDraw = now;
      if (now - lastSpawn > SPAWN_INTERVAL_MS) {
        trails = trails.filter((t) => !isExpired(t, now));
        if (trails.length < maxTrails()) {
          trails.push(Math.random() < 0.75 ? createOrganic(width, height, now) : createRobotic(width, height, now));
        }
        lastSpawn = now;
      }
      drawFrame(ctx, grid, width, height, trails, now, monoFamily);
      start();
    };

    const start = () => {
      if (reducedMotion || !inView || document.hidden || frame) return;
      frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent);
    resize();

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

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

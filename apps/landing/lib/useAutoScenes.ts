"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MANUAL_HOLD_MS = 12000;

interface AutoScenesOptions {
  firstPassMs: number[];
  loopMs: number[];
  enabled: boolean;
  paused: boolean;
}

interface AutoScenes {
  scene: number;
  goTo: (index: number) => void;
  cycle: number;
  durationMs: number;
  running: boolean;
  manual: boolean;
  finished: boolean;
}

export function useAutoScenes({ firstPassMs, loopMs, enabled, paused }: AutoScenesOptions): AutoScenes {
  const count = firstPassMs.length;
  const [scene, setScene] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [loopMode, setLoopMode] = useState(false);
  const [manual, setManual] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);

  const firstPassRef = useRef(firstPassMs);
  const loopRef = useRef(loopMs);
  firstPassRef.current = firstPassMs;
  loopRef.current = loopMs;

  const advancesRef = useRef(0);
  const elapsedRef = useRef(0);
  const startedAtRef = useRef(0);
  const resetElapsedRef = useRef(true);

  const running = enabled && pageVisible && !paused && !manual && !finished;
  const durationMs = (loopMode ? loopMs : firstPassMs)[scene] ?? 0;

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (enabled) {
      resetElapsedRef.current = true;
      setCycle((value) => value + 1);
      return;
    }
    advancesRef.current = 0;
    resetElapsedRef.current = true;
    setLoopMode(false);
    setManual(false);
    setFinished(false);
    setScene(0);
  }, [enabled]);

  useEffect(() => {
    if (!running || count === 0) return;
    if (resetElapsedRef.current) {
      elapsedRef.current = 0;
      resetElapsedRef.current = false;
    }
    const duration = (loopMode ? loopRef.current : firstPassRef.current)[scene];
    startedAtRef.current = performance.now() - elapsedRef.current;
    const timer = window.setTimeout(
      () => {
        resetElapsedRef.current = true;
        if (scene >= count - 1) {
          setFinished(true);
          return;
        }
        advancesRef.current += 1;
        setScene(scene + 1);
      },
      Math.max(0, duration - elapsedRef.current)
    );
    return () => {
      window.clearTimeout(timer);
      elapsedRef.current = performance.now() - startedAtRef.current;
    };
  }, [running, scene, cycle, loopMode, count]);

  useEffect(() => {
    if (!manual) return;
    const timer = window.setTimeout(() => {
      resetElapsedRef.current = true;
      setLoopMode(true);
      setManual(false);
      setCycle((value) => value + 1);
    }, MANUAL_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [manual, scene, cycle]);

  const goTo = useCallback((index: number) => {
    resetElapsedRef.current = true;
    setScene(index);
    setManual(true);
    setFinished(false);
    setCycle((value) => value + 1);
  }, []);

  return { scene, goTo, cycle, durationMs, running, manual, finished };
}

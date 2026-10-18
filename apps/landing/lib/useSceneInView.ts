"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

const THRESHOLDS = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
const MAX_VIEWPORT_SHARE = 0.5;

export function useSceneInView<T extends HTMLElement>(threshold = 0.35): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          setActive(false);
          return;
        }
        const required = Math.min(threshold * entry.boundingClientRect.height, MAX_VIEWPORT_SHARE * window.innerHeight);
        if (entry.intersectionRect.height >= required) setActive(true);
      },
      { threshold: THRESHOLDS }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, active];
}

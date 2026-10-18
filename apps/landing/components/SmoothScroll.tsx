"use client";

import React, { useEffect, useRef } from "react";
import { requestMeasure } from "@/lib/scrollBus";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

export function SmoothScroll({ children }: { children: React.ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const hashHandled = useRef(false);

  useEffect(() => {
    let isLocked = false;
    let lockTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWheelTime = 0;
    let wheelDeltaAccumulator = 0;

    const getPages = (): HTMLElement[] => {
      return Array.from(document.querySelectorAll<HTMLElement>("[data-page]"));
    };

    const isDesktopSnap = (): boolean => {
      return !reducedMotion && window.matchMedia("(min-width: 1024px)").matches;
    };

    const isInsideScrollable = (target: Element | null): boolean => {
      if (!target) return false;
      if (document.body.style.overflow === "hidden") return true;
      if (target.closest('[role="dialog"], [data-scrollable="true"], select, textarea, input')) {
        return true;
      }
      return false;
    };

    const scrollToPage = (targetIndex: number) => {
      const pages = getPages();
      if (targetIndex < 0 || targetIndex >= pages.length) return;
      const targetPage = pages[targetIndex];
      const targetTop = targetPage.getBoundingClientRect().top + window.scrollY;

      isLocked = true;
      window.scrollTo({
        top: Math.round(targetTop),
        behavior: reducedMotion ? "auto" : "smooth",
      });

      if (lockTimer) clearTimeout(lockTimer);

      const checkUnlock = () => {
        const now = performance.now();
        // Cooldown: at least 650ms has elapsed since scroll initiated, and at least 150ms of quiet time from wheel events
        if (now - lastWheelTime >= 150) {
          isLocked = false;
          wheelDeltaAccumulator = 0;
        } else {
          lockTimer = setTimeout(checkUnlock, 80);
        }
      };

      lockTimer = setTimeout(checkUnlock, 650);
    };

    const stepPage = (direction: 1 | -1) => {
      const pages = getPages();
      if (pages.length === 0) return;

      const currentY = window.scrollY;
      const vh = window.innerHeight;

      let closestIdx = 0;
      let minDiff = Infinity;
      pages.forEach((page, i) => {
        const top = page.getBoundingClientRect().top + currentY;
        const diff = Math.abs(currentY - top);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      });

      const currentPage = pages[closestIdx];
      const pageTop = currentPage.getBoundingClientRect().top + currentY;
      const pageHeight = currentPage.offsetHeight;
      const maxScrollForCurrent = pageTop + pageHeight - vh;

      const isTallPage = pageHeight > vh + 40;

      if (direction === 1) {
        if (isTallPage && currentY < maxScrollForCurrent - 20) {
          isLocked = true;
          const nextY = Math.min(maxScrollForCurrent, currentY + vh * 0.75);
          window.scrollTo({ top: Math.round(nextY), behavior: "smooth" });
          if (lockTimer) clearTimeout(lockTimer);
          lockTimer = setTimeout(() => {
            isLocked = false;
            wheelDeltaAccumulator = 0;
          }, 500);
          return;
        }

        const nextIdx = Math.min(pages.length - 1, closestIdx + 1);
        if (nextIdx !== closestIdx) {
          scrollToPage(nextIdx);
        } else {
          isLocked = true;
          if (lockTimer) clearTimeout(lockTimer);
          lockTimer = setTimeout(() => {
            isLocked = false;
            wheelDeltaAccumulator = 0;
          }, 300);
        }
      } else {
        if (isTallPage && currentY > pageTop + 20) {
          isLocked = true;
          const nextY = Math.max(pageTop, currentY - vh * 0.75);
          window.scrollTo({ top: Math.round(nextY), behavior: "smooth" });
          if (lockTimer) clearTimeout(lockTimer);
          lockTimer = setTimeout(() => {
            isLocked = false;
            wheelDeltaAccumulator = 0;
          }, 500);
          return;
        }

        const prevIdx = Math.max(0, closestIdx - 1);
        if (prevIdx !== closestIdx) {
          scrollToPage(prevIdx);
        } else {
          isLocked = true;
          if (lockTimer) clearTimeout(lockTimer);
          lockTimer = setTimeout(() => {
            isLocked = false;
            wheelDeltaAccumulator = 0;
          }, 300);
        }
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!isDesktopSnap()) return;
      if (isInsideScrollable(event.target as Element | null)) return;

      event.preventDefault();
      lastWheelTime = performance.now();

      if (isLocked) {
        return;
      }

      wheelDeltaAccumulator += event.deltaY;
      if (Math.abs(wheelDeltaAccumulator) < 25) {
        return;
      }

      const direction = wheelDeltaAccumulator > 0 ? 1 : -1;
      wheelDeltaAccumulator = 0;
      stepPage(direction);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isDesktopSnap()) return;
      const target = event.target as HTMLElement | null;
      if (isInsideScrollable(target)) return;

      let direction: 1 | -1 | 0 = 0;
      if (event.key === "ArrowDown" || event.key === "PageDown" || (event.key === " " && !event.shiftKey)) {
        direction = 1;
      } else if (event.key === "ArrowUp" || event.key === "PageUp" || (event.key === " " && event.shiftKey)) {
        direction = -1;
      }

      if (direction !== 0) {
        event.preventDefault();
        if (isLocked) return;
        stepPage(direction);
      }
    };

    const scrollToId = (id: string, immediate: boolean) => {
      const target = document.getElementById(id);
      if (!target) return false;
      const targetTop = target.getBoundingClientRect().top + window.scrollY;

      if (isDesktopSnap()) {
        isLocked = true;
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = setTimeout(() => {
          isLocked = false;
          wheelDeltaAccumulator = 0;
        }, 700);
      }

      window.scrollTo({
        top: Math.round(targetTop),
        behavior: immediate || reducedMotion ? "auto" : "smooth",
      });
      return true;
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("#") && !href.startsWith("/#")) return;
      const id = href.slice(href.indexOf("#") + 1);
      if (!id || !scrollToId(id, false)) return;
      event.preventDefault();
      history.pushState(null, "", `#${id}`);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);

    if (window.location.hash && !hashHandled.current) {
      hashHandled.current = true;
      const id = window.location.hash.slice(1);
      requestMeasure();
      document.fonts?.ready.then(() => requestAnimationFrame(() => scrollToId(id, true)));
    }

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      if (lockTimer) clearTimeout(lockTimer);
    };
  }, [reducedMotion]);

  return <>{children}</>;
}

"use client";

import React, { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Shield, Menu, X } from "lucide-react";
import { BrowserIcon } from "@/components/BrowserIcon";
import { useInstall } from "@/components/InstallProvider";
import { registerMeasure, subscribe, type ScrollState } from "@/lib/scrollBus";
import { useBrowser } from "@/lib/useBrowser";
import { useScrollLock } from "@/lib/useScrollLock";
import { cn } from "@/lib/utils";

interface NavGroup {
  id: string;
  label: string;
  href: string;
  matchedSections: string[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: "how",
    label: "How it works",
    href: "/#how-it-works",
    matchedSections: ["why", "how-it-works", "models"],
  },
  {
    id: "extension",
    label: "Extension",
    href: "/#extension",
    matchedSections: ["extension"],
  },
  {
    id: "hood",
    label: "Under the hood",
    href: "/#features",
    matchedSections: ["features"],
  },
  {
    id: "comparison",
    label: "Compare",
    href: "/#comparison",
    matchedSections: ["comparison", "faq"],
  },
  {
    id: "playground",
    label: "Playground",
    href: "/playground",
    matchedSections: [],
  },
  {
    id: "samples",
    label: "Live Triggers",
    href: "/sample1",
    matchedSections: ["samples"],
  },
];

export function Header() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>("");
  const pathname = usePathname();
  const browser = useBrowser();
  const { openInstall } = useInstall();
  const progressBarRef = useRef<HTMLDivElement>(null);

  useScrollLock(isMobileMenuOpen);

  useEffect(() => {
    const sectionIds = ["why", "how-it-works", "models", "extension", "features", "comparison", "faq", "install", "manual-install"];
    let sections: { id: string; top: number; bottom: number }[] = [];
    let docHeight = 0;
    let scrolled = false;
    let active = "";

    const measure = () => {
      sections = [];
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        sections.push({ id, top, bottom: top + rect.height });
      }
      docHeight = document.documentElement.scrollHeight;
    };

    const update = ({ y, vh }: ScrollState) => {
      const nextScrolled = y > 20;
      if (nextScrolled !== scrolled) {
        scrolled = nextScrolled;
        setIsScrolled(nextScrolled);
      }

      if (progressBarRef.current) {
        const scrollable = docHeight - vh;
        const pageProgress = scrollable > 0 ? Math.min(Math.max(y / scrollable, 0), 1) : 0;
        progressBarRef.current.style.transform = `scaleX(${pageProgress.toFixed(4)})`;
      }

      const probe = y + 220;
      let current = "";
      for (const section of sections) {
        if (probe >= section.top && probe < section.bottom) {
          current = section.id;
          break;
        }
      }
      if (current !== active) {
        active = current;
        setActiveSection(current);
      }
    };

    const unregister = registerMeasure(measure);
    const unsubscribe = subscribe(update);
    return () => {
      unsubscribe();
      unregister();
    };
  }, []);

  const handleInstall = () => {
    setIsMobileMenuOpen(false);
    openInstall();
  };

  const mobileNavLinks = [
    ...NAV_GROUPS,
    { id: "faq", label: "FAQ", href: "/#faq", matchedSections: ["faq"] },
    { id: "install", label: "Install & Download", href: "/#install", matchedSections: ["install", "manual-install"] },
  ];

  return (
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 border-b transition-colors duration-200",
          isScrolled || isMobileMenuOpen
            ? "border-white/[0.08] bg-ink-950/[0.92] backdrop-blur-md"
            : "border-transparent bg-transparent"
        )}
      >
        <div className="container-x flex h-16 items-center justify-between gap-6">
          <a href="/" className="flex shrink-0 items-center gap-2.5 min-h-[44px]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-shield/60 text-shield">
              <Shield className="h-4 w-4" strokeWidth={2.2} />
            </span>
            <span className="font-display text-lg font-bold tracking-tight text-white">PhishGuard</span>
          </a>

          <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">
            {NAV_GROUPS.map((group) => {
              const isActive = group.matchedSections.includes(activeSection) || (group.id === "playground" && Boolean(pathname?.startsWith("/playground")));
              return (
                <a
                  key={group.id}
                  href={group.href}
                  className={cn(
                    "border-b-2 py-5 text-sm font-medium transition-colors",
                    isActive
                      ? "border-shield text-white"
                      : "border-transparent text-white/60 hover:text-white"
                  )}
                >
                  {group.label}
                </a>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <button
              onClick={handleInstall}
              className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full bg-shield px-4 text-sm font-bold text-ink-950 transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
            >
              <BrowserIcon id={browser.id} className="h-4 w-4" />
              <span className="hidden sm:inline">{browser.actionText}</span>
              <span className="sm:hidden">{browser.isMobile ? "Get App" : "Install"}</span>
            </button>
            <button
              onClick={() => setIsMobileMenuOpen((v) => !v)}
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-menu"
              aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-white lg:hidden"
            >
              {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        <div
          ref={progressBarRef}
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 bottom-[-1px] h-0.5 origin-left bg-shield transition-opacity duration-200",
            isScrolled ? "opacity-100" : "opacity-0"
          )}
          style={{ transform: "scaleX(0)" }}
        />
      </header>

      {isMobileMenuOpen && (
        <div
          id="mobile-menu"
          className="fixed inset-x-0 bottom-0 top-16 z-40 overflow-y-auto bg-ink-950/95 backdrop-blur-2xl lg:hidden animate-fade-in"
        >
          <nav className="container-x flex flex-col pt-3" aria-label="Mobile">
            {mobileNavLinks.map((group) => {
              const isActive = group.matchedSections?.includes(activeSection) || (group.id === "playground" && Boolean(pathname?.startsWith("/playground")));
              return (
                <a
                  key={group.id}
                  href={group.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={cn(
                    "flex min-h-[48px] items-center border-b border-white/[0.08] py-3.5 text-lg font-medium",
                    isActive ? "text-shield" : "text-white"
                  )}
                >
                  {group.label}
                </a>
              );
            })}
          </nav>
          <div className="container-x flex items-center gap-3 pt-6 pb-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
            <button
              onClick={handleInstall}
              className="inline-flex min-h-[50px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-shield px-5 text-base font-bold text-ink-950 shadow-lg"
            >
              <BrowserIcon id={browser.id} className="h-5 w-5" />
              <span>{browser.actionText}</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

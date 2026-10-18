"use client";

import React from "react";
import Link from "next/link";
import { Shield, CheckCircle2, AlertTriangle, ShieldAlert, ArrowLeft } from "lucide-react";

interface SampleNavProps {
  currentSample: 1 | 2 | 3;
}

export function SampleNav({ currentSample }: SampleNavProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-ink-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/20 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">PhishGuard Home</span>
            <span className="sm:hidden">Home</span>
          </Link>
          <div className="hidden h-4 w-px bg-white/15 md:block" />
          <div className="flex items-center gap-2 font-mono text-xs text-white/50">
            <Shield className="h-4 w-4 text-shield" />
            <span className="font-semibold text-white">Model Trigger Testbench</span>
          </div>
        </div>

        <nav className="flex items-center gap-1.5 sm:gap-2">
          <Link
            href="/sample1"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
              currentSample === 1
                ? "bg-shield/20 text-shield border border-shield/40 shadow-sm shadow-shield/10"
                : "text-white/60 hover:text-white hover:bg-white/5 border border-transparent"
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Sample 1: Safe</span>
          </Link>

          <Link
            href="/sample2"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
              currentSample === 2
                ? "bg-alert/20 text-alert border border-alert/40 shadow-sm shadow-alert/10"
                : "text-white/60 hover:text-white hover:bg-white/5 border border-transparent"
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Sample 2: Ambiguous</span>
          </Link>

          <Link
            href="/sample3"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
              currentSample === 3
                ? "bg-quarantine/20 text-quarantine border border-quarantine/40 shadow-sm shadow-quarantine/10"
                : "text-white/60 hover:text-white hover:bg-white/5 border border-transparent"
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>Sample 3: Block</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

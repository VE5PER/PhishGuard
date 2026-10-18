"use client";

import React from "react";
import { useReveal } from "@/lib/useReveal";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  index?: string;
  label: string;
  title: React.ReactNode;
  lead: React.ReactNode;
  stacked?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function SectionHeader({ index, label, title, lead, stacked = false, className, children }: SectionHeaderProps) {
  const ref = useReveal<HTMLDivElement>();

  const heading = (
    <>
      <p className="eyebrow">
        {index ? `${index} / ${label}` : label}
      </p>
      <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em] text-white">
        {title}
      </h2>
    </>
  );

  if (stacked) {
    return (
      <div ref={ref} className={cn("reveal", className)}>
        {heading}
        <p className="mt-6 text-[17px] leading-relaxed text-white/60">{lead}</p>
        {children}
      </div>
    );
  }

  return (
    <div ref={ref} className={cn("reveal grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-12", className)}>
      <div className="lg:col-span-7">{heading}</div>
      <div className="lg:col-span-5 lg:self-end">
        <p className="text-[17px] leading-relaxed text-white/60">{lead}</p>
        {children}
      </div>
    </div>
  );
}

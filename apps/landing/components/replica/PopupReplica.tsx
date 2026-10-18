import React from "react";
import { cn } from "@/lib/utils";
import type { PopupSignalStatus, PopupState, PopupVerdict } from "@/lib/popupStates";

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const mono: React.CSSProperties = { fontFamily: MONO };

const VERDICT_WORD: Record<PopupVerdict, string> = {
  safe: "SAFE",
  ambiguous: "AMBIGUOUS",
  block: "BLOCKED",
};

const VERDICT_COLOR: Record<PopupVerdict, string> = {
  safe: "#C6F432",
  ambiguous: "#FFB224",
  block: "#FF5A46",
};

const SIGNAL_COLOR: Record<PopupSignalStatus, string> = {
  ok: "#C6F432",
  flag: "#FFB224",
  skipped: "rgba(255,255,255,0.3)",
};

const HAIR = "border-white/[0.08]";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-white/[0.62]">{children}</div>;
}

function DetailRow({ label, value, valueStyle, valueClass }: { label: string; value: string; valueStyle?: React.CSSProperties; valueClass?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-t py-[7px] text-xs text-white/[0.62] first:border-t-0", HAIR)}>
      <span className="shrink-0 text-white/[0.42]">{label}</span>
      <span className={valueClass} style={valueStyle}>
        {value}
      </span>
    </div>
  );
}

export interface PopupCloudResult {
  action: "ALLOW" | "WARN" | "BLOCK";
  confidence: number;
  brand: string | null;
  teacherModelVersion: string;
  reasons: string[];
}

interface PopupReplicaProps {
  state: PopupState;
  className?: string;
  cloud?: PopupCloudResult | null;
  cloudReveal?: number;
  screenshotChecked?: boolean;
}

export function PopupReplica({ state, className, cloud = null, cloudReveal = 1, screenshotChecked }: PopupReplicaProps) {
  const color = VERDICT_COLOR[state.verdict];
  const fill = Math.max(state.score * 100, 5);

  return (
    <div
      className={cn("w-[360px] overflow-hidden rounded-xl border border-white/10 bg-[#08090A] text-[13px] text-[#F5F5F7]", className)}
      style={{ fontFamily: FONT }}
      data-popup-state={state.verdict}
    >
      <div className={cn("flex items-center justify-between border-b px-4 py-3.5", HAIR)}>
        <div className="flex items-center gap-2 text-[15px] font-bold tracking-[-0.02em]">
          <svg className="h-5 w-5 text-[#C6F432]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>PhishGuard</span>
        </div>
        <span className="flex h-7 w-7 items-center justify-center rounded-full text-white/[0.62]" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
      </div>

      <div className={cn("border-b px-4 pb-4 pt-[18px]", HAIR)}>
        <div className="flex items-center justify-between gap-3">
          <div
            className="inline-flex items-center gap-2 text-[22px] font-extrabold uppercase leading-none tracking-[-0.01em] transition-colors duration-300"
            style={{ color }}
            data-id="status-badge"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
            {VERDICT_WORD[state.verdict]}
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="text-[11px] uppercase tracking-[0.06em] text-white/[0.42]" style={mono}>
              RISK PERCENTAGE
            </div>
            <div
              className="text-[40px] font-extrabold leading-none tracking-[-0.03em] tabular-nums transition-colors duration-300"
              style={{ color }}
              data-id="risk-score"
            >
              {Math.round(state.score * 100)}%
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.06em] text-white/[0.42]" style={mono}>
            Target Host
          </div>
          <div className="mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap text-[13px]" style={mono} data-id="domain-text">
            {state.domain}
          </div>
        </div>

        <div className="mt-4 text-[11px] text-white/[0.42]">Multimodal Risk Probability</div>
        <div
          className="relative mt-2 h-2 rounded-full"
          style={{
            background:
              "linear-gradient(90deg, rgba(198,244,50,.18) 0 15%, rgba(255,178,36,.18) 15% 85%, rgba(255,90,70,.18) 85% 100%)",
          }}
        >
          <span className="absolute -bottom-[3px] -top-[3px] left-[15%] w-px bg-white/[0.14]" />
          <span className="absolute -bottom-[3px] -top-[3px] left-[85%] w-px bg-white/[0.14]" />
          <div
            className="relative z-[1] h-full rounded-full transition-[width,background-color] duration-300"
            style={{ width: `${fill}%`, backgroundColor: color }}
            data-id="meter-fill"
          />
        </div>
        <div className="relative mt-1.5 h-3.5 text-[11px] text-white/[0.42]" style={mono}>
          <span className="absolute -translate-x-1/2" style={{ left: "15%" }}>
            0.15
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: "85%" }}>
            0.85
          </span>
        </div>
      </div>

      <div className={cn("border-b px-4 py-4", HAIR)}>
        <div className="mb-2.5">
          <SectionTitle>Signals</SectionTitle>
        </div>
        {state.signals.map((signal) => (
          <div key={signal.label} className={cn("flex items-center gap-2.5 border-t py-[9px] text-xs first:border-t-0", HAIR)}>
            <span className="w-[74px] shrink-0 text-white/[0.62]">{signal.label}</span>
            <span
              className="h-2 w-2 shrink-0 rounded-full transition-colors duration-300"
              style={{ backgroundColor: SIGNAL_COLOR[signal.status] }}
              data-signal-status={signal.status}
            />
            <span className="min-w-0 text-white/90">{signal.detail}</span>
          </div>
        ))}
      </div>

      <div className={cn("border-b px-4 py-4", HAIR)}>
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-[7px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/[0.62]" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
              <rect x="9" y="9" width="6" height="6" />
            </svg>
            <SectionTitle>On-Device Model</SectionTitle>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#C6F432]" style={mono}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            SYNCED
          </span>
        </div>
        <DetailRow label="Version" value={state.model.version} valueClass="font-semibold text-[#F5F5F7]" />
        <DetailRow label="Extension Version" value={state.model.extensionVersion} valueClass="font-semibold text-[#F5F5F7]" />
        <div className={cn("flex items-center justify-between gap-3 border-t py-[7px] text-xs text-white/[0.62] first:border-t-0", HAIR)}>
          <span className="shrink-0 text-white/[0.42]">Warning Alert</span>
          <select
            defaultValue="smart"
            className="rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-0.5 text-[11px] font-semibold text-[#C6F432] outline-none transition-colors hover:border-white/30 focus:border-[#C6F432]"
            aria-label="Warning alert type"
          >
            <option value="smart" className="bg-[#141518] text-white">Smart Adaptive</option>
            <option value="overlay" className="bg-[#141518] text-white">Full-Screen Overlay</option>
            <option value="banner" className="bg-[#141518] text-white">Top Warning Banner</option>
            <option value="notification" className="bg-[#141518] text-white">Notification Toast</option>
          </select>
        </div>
      </div>

      <div
        className={cn(
          "border-b border-l-2 px-4 py-4 transition-colors duration-300",
          HAIR,
          state.verdict === "ambiguous" ? "bg-[rgba(255,178,36,0.06)]" : "bg-transparent"
        )}
        style={{ borderLeftColor: state.verdict === "ambiguous" ? "#FFB224" : "transparent" }}
      >
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-[7px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/[0.62]" aria-hidden="true">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
            </svg>
            <SectionTitle>Cloud Verification</SectionTitle>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em]",
              cloud ? "text-[#C6F432]" : "text-white/[0.42]"
            )}
            style={mono}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {cloud ? "VERIFIED" : "Optional"}
          </span>
        </div>
        {cloud ? (
          <div className="overflow-hidden" style={{ maxHeight: `${cloudReveal * 520}px`, opacity: cloudReveal }} data-id="cloud-result">
            <div
              className={cn(
                "mb-1.5 border-l-2 border-current px-2.5 py-2",
                cloud.action === "BLOCK" && "bg-[rgba(255,90,70,0.08)] text-[#FF5A46]",
                cloud.action === "WARN" && "bg-[rgba(255,178,36,0.08)] text-[#FFB224]",
                cloud.action === "ALLOW" && "bg-[rgba(198,244,50,0.08)] text-[#C6F432]"
              )}
              data-id="cloud-verdict-box"
            >
              <div className="text-xs font-bold">{`${cloud.action} • ${Math.round(cloud.confidence * 100)}% Confidence`}</div>
            </div>
            {cloud.brand ? (
              <DetailRow label="Brand Grounding" value={cloud.brand} valueClass="font-semibold text-[#FF5A46]" />
            ) : null}
            <DetailRow label="Cloud Verifier" value={cloud.teacherModelVersion} />
            <ul className="mt-2 list-disc pl-[18px] text-xs leading-[1.5] text-white/[0.62]">
              {cloud.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-2.5 w-full rounded-full border border-white/[0.14] bg-transparent px-3 py-[7px] text-[11px] font-semibold text-[#F5F5F7]"
            >
              Re-verify with Cloud
            </button>
          </div>
        ) : (
          <>
            <p className="mb-2.5 text-xs leading-[1.45] text-white/[0.62]">{state.cloudDescription}</p>
            <label className="mb-1 flex cursor-pointer items-center gap-2 text-xs text-white/90">
              {screenshotChecked === undefined ? (
                <input type="checkbox" data-id="screenshot-checkbox" className="h-3.5 w-3.5 accent-[#C6F432]" />
              ) : (
                <input type="checkbox" data-id="screenshot-checkbox" checked={screenshotChecked} readOnly className="h-3.5 w-3.5 accent-[#C6F432]" />
              )}
              Include a screenshot of this page
            </label>
            <p className="mb-2.5 pl-[22px] text-[11px] text-white/[0.42]">Sent once for this check, then discarded.</p>
            <button
              type="button"
              data-id="request-cloud"
              className="w-full rounded-full border border-white/[0.14] bg-transparent px-3.5 py-2.5 text-xs font-semibold text-[#F5F5F7] hover:bg-white/[0.06]"
            >
              Request Cloud Verification
            </button>
          </>
        )}
      </div>

      <div className={cn("sticky bottom-0 border-t bg-[#08090A] px-4 pb-2.5 pt-3", HAIR)}>
        <div className="flex gap-2">
          <button type="button" className="flex-[1.4] rounded-full bg-[#C6F432] px-3.5 py-2.5 text-xs font-bold text-[#08090A]">
            Re-evaluate Page
          </button>
          <button
            type="button"
            className="flex-1 rounded-full border border-white/[0.14] bg-transparent px-3.5 py-2.5 text-xs font-semibold text-[#F5F5F7]"
          >
            Check Model Update
          </button>
        </div>
      </div>
    </div>
  );
}

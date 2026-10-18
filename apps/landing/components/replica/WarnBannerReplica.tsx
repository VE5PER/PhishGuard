import React from "react";

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

interface WarnBannerReplicaProps {
  brand?: string | null;
  hostname: string;
  reason?: string | null;
  onLeave?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function WarnBannerReplica({ brand, hostname, reason, onLeave, onDismiss, className }: WarnBannerReplicaProps) {
  const reasonText = reason || "Suspicious behavioral anomaly detected";
  const description = brand
    ? `Suspected ${brand} impersonation on ${hostname} — ${reasonText}`
    : `Deceptive website detected on ${hostname} — ${reasonText}`;

  return (
    <div
      className={className}
      style={{
        boxSizing: "border-box",
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        background: "#0E0F11",
        borderBottom: "2px solid #FF5A46",
        boxShadow: "0 4px 24px rgba(0, 0, 0, 0.7)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        color: "#fff",
        fontFamily: FONT,
        zIndex: 60,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", flex: 1, minWidth: 260 }}>
        <span
          style={{
            display: "inline-block",
            fontFamily: MONO,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            background: "#FF5A46",
            color: "#fff",
            fontWeight: 800,
            padding: "3px 8px",
            borderRadius: 4,
          }}
        >
          PHISHGUARD WARNING
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{description}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onLeave}
          style={{
            display: "inline-block",
            background: "#FF5A46",
            color: "#fff",
            border: "none",
            padding: "7px 16px",
            borderRadius: 999,
            fontWeight: 700,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          Leave Site
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            display: "inline-block",
            background: "transparent",
            color: "rgba(255, 255, 255, 0.85)",
            border: "1px solid rgba(255, 255, 255, 0.24)",
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

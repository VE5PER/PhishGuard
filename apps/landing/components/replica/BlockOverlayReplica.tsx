import React from "react";

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

interface BlockOverlayReplicaProps {
  brand?: string | null;
  reasons: string[];
  onLeave?: () => void;
  onIgnore?: () => void;
  className?: string;
}

export function BlockOverlayReplica({ brand, reasons, onLeave, onIgnore, className }: BlockOverlayReplicaProps) {
  return (
    <div
      className={className}
      style={{
        boxSizing: "border-box",
        position: "absolute",
        inset: 0,
        background: "rgba(8, 9, 10, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          boxSizing: "border-box",
          display: "block",
          background: "#0E0F11",
          border: "1px solid rgba(255, 255, 255, 0.10)",
          borderTop: "3px solid #FF5A46",
          borderRadius: 16,
          maxWidth: 560,
          width: "90%",
          maxHeight: "90%",
          overflowY: "auto",
          padding: 32,
          textAlign: "left",
          color: "#fff",
        }}
      >
        <div
          style={{
            display: "block",
            fontFamily: MONO,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "#FF5A46",
            marginBottom: 12,
          }}
        >
          PhishGuard · Blocked
        </div>

        <h2
          style={{
            display: "block",
            fontSize: 28,
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            color: "#fff",
            margin: "0 0 12px",
            fontFamily: FONT,
          }}
        >
          Deceptive Website Detected
        </h2>

        <p
          style={{
            display: "block",
            fontSize: 15,
            lineHeight: 1.5,
            color: "rgba(255, 255, 255, 0.62)",
            margin: "0 0 16px",
          }}
        >
          PhishGuard blocked this page based on on-device behavioral telemetry and cloud verification.
        </p>

        {brand ? (
          <div
            style={{
              display: "block",
              background: "rgba(255, 90, 70, 0.10)",
              borderLeft: "3px solid #FF5A46",
              padding: "12px 14px",
              margin: "16px 0",
              fontSize: 14,
              fontWeight: 600,
              color: "#FF8A7A",
            }}
          >
            Suspected Brand Impersonation: {brand}
          </div>
        ) : null}

        {reasons.length > 0 ? (
          <ul style={{ display: "block", margin: "16px 0", padding: 0, listStyle: "none" }}>
            {reasons.map((reason, index) => (
              <li
                key={reason}
                style={{
                  display: "block",
                  padding: "10px 0",
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: "rgba(255, 255, 255, 0.62)",
                  borderTop: index > 0 ? "1px solid rgba(255, 255, 255, 0.08)" : undefined,
                }}
              >
                {reason}
              </li>
            ))}
          </ul>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
          <button
            type="button"
            onClick={onLeave}
            style={{
              display: "inline-block",
              background: "#FF5A46",
              color: "#fff",
              border: "none",
              padding: "12px 24px",
              borderRadius: 999,
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            Leave Site (Recommended)
          </button>
          <button
            type="button"
            onClick={onIgnore}
            style={{
              display: "inline-block",
              background: "transparent",
              color: "rgba(255, 255, 255, 0.62)",
              border: "1px solid rgba(255, 255, 255, 0.14)",
              padding: "12px 20px",
              borderRadius: 999,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            Ignore Warning & Continue
          </button>
        </div>
      </div>
    </div>
  );
}

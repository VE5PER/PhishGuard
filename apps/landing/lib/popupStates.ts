import { fmtPct, type ProductFacts } from "@/lib/facts";

export type PopupVerdict = "safe" | "ambiguous" | "block";
export type PopupSignalStatus = "ok" | "flag" | "skipped";

export interface PopupSignal {
  label: "Interaction" | "Page" | "Vision";
  status: PopupSignalStatus;
  detail: string;
}

export interface PopupState {
  verdict: PopupVerdict;
  score: number;
  domain: string;
  signals: [PopupSignal, PopupSignal, PopupSignal];
  cloudDescription: string;
  model: {
    version: string;
    source: string;
    accuracy: string;
    hash: string;
    clientDb: string;
    extensionVersion: string;
  };
}

export type PopupStateKey = "safe" | "suspicious" | "blocked";

export function getPopupStates(facts: ProductFacts, domains?: Partial<Record<PopupStateKey, string>>): Record<PopupStateKey, PopupState> {
  const model: PopupState["model"] = {
    version: `v${facts.modelVersion}`,
    source: "Cloud Registry (Dynamic)",
    accuracy: fmtPct(facts.accuracy),
    hash: `${facts.modelSha256.slice(0, 8)}...`,
    clientDb: "SQLite (WASM)",
    extensionVersion: `v${facts.extensionVersion}`,
  };

  return {
    safe: {
      verdict: "safe",
      score: 0.04,
      domain: domains?.safe ?? "accounts.google.com",
      signals: [
        { label: "Interaction", status: "ok", detail: "Natural movement · 142 samples" },
        { label: "Page", status: "ok", detail: "No hidden elements" },
        { label: "Vision", status: "ok", detail: "Logo and layout match this domain" },
      ],
      cloudDescription: "Local inference runs 100% on-device. Cloud verification is completely optional.",
      model,
    },
    suspicious: {
      verdict: "ambiguous",
      score: 0.48,
      domain: domains?.suspicious ?? "internal-id-verification.co",
      signals: [
        { label: "Interaction", status: "ok", detail: "Natural movement · 88 samples" },
        { label: "Page", status: "flag", detail: "1 hidden trap" },
        { label: "Vision", status: "flag", detail: "Looks like another brand's login page" },
      ],
      cloudDescription:
        "Local score is Ambiguous (0.15–0.85). Cloud escalation is never automatic. You may optionally request deep cloud verification.",
      model,
    },
    blocked: {
      verdict: "block",
      score: 0.94,
      domain: domains?.blocked ?? "login-verify-paypa1.xyz",
      signals: [
        { label: "Interaction", status: "flag", detail: "Robotic movement · 212 samples" },
        { label: "Page", status: "flag", detail: "2 hidden traps" },
        { label: "Vision", status: "flag", detail: "Looks like another brand's login page" },
      ],
      cloudDescription:
        "Local model classified this page as HIGH RISK (Blocked). You may optionally request cloud confirmation.",
      model,
    },
  };
}

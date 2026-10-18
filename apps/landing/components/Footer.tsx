import React from "react";
import { Shield, ExternalLink } from "lucide-react";

const HEADING = "mb-5 font-mono text-xs uppercase tracking-[0.14em] text-white/55";
const LINK = "transition-colors hover:text-white inline-block py-1";

const PRODUCT_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "How models learn", href: "/#models" },
  { label: "Extension", href: "/#extension" },
  { label: "Under the hood", href: "/#features" },
  { label: "Compare", href: "/#comparison" },
  { label: "FAQ", href: "/#faq" },
  { label: "Install", href: "/#install" },
];

export function Footer() {
  return (
    <footer
      id="footer"
      data-page
      className="relative flex lg:min-h-[100svh] flex-col justify-between border-t border-white/[0.08] bg-ink-950 py-12 lg:py-16 font-body text-sm text-white/55"
    >
      <div className="container-x flex min-h-0 flex-1 flex-col justify-between">
        <div className="my-auto grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-shield/60 text-shield">
                <Shield className="h-4 w-4" strokeWidth={2.2} />
              </span>
              <span className="font-display text-lg font-bold text-white">PhishGuard</span>
            </div>
            <p className="mb-6 max-w-sm leading-relaxed">
              On-device phishing and fraud detection for people, financial institutions and the AI agents that browse for them. Never records what you type.
            </p>

            <p className="flex items-center gap-2 font-mono text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-shield" />
              <a href="/health" className="text-white/70 transition-colors hover:text-white">
                System status
              </a>
            </p>
          </div>

          <div>
            <h4 className={HEADING}>Product</h4>
            <ul className="space-y-3">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={LINK}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className={HEADING}>Developers</h4>
            <ul className="space-y-3">
              <li>
                <a href="/download/extension" download className={LINK}>
                  Download .zip
                </a>
              </li>
              <li>
                <a href="/docs" target="_blank" rel="noopener noreferrer" className={`${LINK} flex items-center gap-1.5`}>
                  API docs <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </li>
              <li>
                <a href="/v1/models/latest" className={`${LINK} flex items-center gap-1.5`}>
                  Model registry API <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </li>
              <li>
                <a href="/health" className={LINK}>
                  Health check
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/[0.08] pt-8 text-center font-mono text-xs text-white/55 sm:text-left">
          &copy; 2026 PhishGuard.
        </div>
      </div>
    </footer>
  );
}

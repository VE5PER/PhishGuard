import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const display = localFont({
  src: [
    { path: "./fonts/SpaceGrotesk-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/SpaceGrotesk-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-display",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const body = localFont({
  src: [
    { path: "./fonts/Manrope-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Manrope-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Manrope-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/Manrope-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-body",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const mono = localFont({
  src: [
    { path: "./fonts/JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

export const viewport: Viewport = {
  themeColor: "#08090A",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "PhishGuard — Phishing stops here. For humans and AI agents.",
  description:
    "A browser extension that catches phishing pages, banking fraud and invisible traps on your device, before credentials leak. Never records keystrokes. Works in Chrome, Brave and Edge.",
  keywords: [
    "phishing protection",
    "browser extension",
    "on-device AI",
    "AI agent security",
    "clickjacking detection",
    "Chrome extension",
    "privacy",
    "fraud detection",
    "banking security",
    "financial institutions",
    "risk management",
  ],
  authors: [{ name: "PhishGuard Security Systems" }],
  openGraph: {
    title: "PhishGuard — Phishing stops here. For humans and AI agents.",
    description:
      "On-device phishing and fraud detection for people, financial institutions and the AI agents that browse for them. Free, no account, never records what you type.",
    url: "https://phishguard.security",
    siteName: "PhishGuard",
    locale: "en_US",
    type: "website",
  },
  icons: {
    icon: "/icons/icon48.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body className="min-h-screen bg-ink-950 text-[#f5f5f7] antialiased selection:bg-shield/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}

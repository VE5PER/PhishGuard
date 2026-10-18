import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { InstallProvider } from "@/components/InstallProvider";
import { SmoothScroll } from "@/components/SmoothScroll";
import { InteractivePlayground } from "@/components/playground/InteractivePlayground";

export const metadata: Metadata = {
  title: "Threat Playground — PhishGuard",
  description:
    "Replay PhishGuard on realistic phishing and benign pages: the on-device verdict, the cloud escalation and the Gemini forensic agent's answer.",
};

export default function PlaygroundPage() {
  return (
    <main className="min-h-screen bg-ink-950 text-white flex flex-col selection:bg-shield/30 selection:text-white">
      <InstallProvider>
        <SmoothScroll>
          <Header />
          <div className="pt-24 lg:pt-28">
            <InteractivePlayground />
          </div>
          <Footer />
        </SmoothScroll>
      </InstallProvider>
    </main>
  );
}

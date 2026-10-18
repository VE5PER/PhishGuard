import React from "react";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { WhyStatement } from "@/components/WhyStatement";
import { ExtensionShowcase } from "@/components/ExtensionShowcase";
import { Benefits } from "@/components/Benefits";
import { ModelLifecycle } from "@/components/ModelLifecycle";
import { Comparison } from "@/components/Comparison";
import { FAQ } from "@/components/FAQ";
import { InstallGuide } from "@/components/InstallGuide";
import { Footer } from "@/components/Footer";
import { InstallProvider } from "@/components/InstallProvider";
import { SmoothScroll } from "@/components/SmoothScroll";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-ink-950 text-white flex flex-col selection:bg-shield/30 selection:text-white">
      <InstallProvider>
        <SmoothScroll>
          <Header />
          <Hero />
          <WhyStatement />
          <HowItWorks />
          <ModelLifecycle />
          <ExtensionShowcase />
          <Benefits />
          <Comparison />
          <FAQ />
          <InstallGuide />
          <Footer />
        </SmoothScroll>
      </InstallProvider>
    </main>
  );
}

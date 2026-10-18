"use client";

import React from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { fmtKB, type ProductFacts } from "@/lib/facts";
import { useProductFacts } from "@/lib/useProductFacts";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

const getFaqs = (facts: ProductFacts): FAQItem[] => [
  {
    id: "item-1",
    question: "How does it protect both people and AI agents?",
    answer:
      "Each gives itself away differently. People get fooled by convincing clones, so PhishGuard checks the page itself—look-alike domains, borrowed logos, hidden form overlays—and freezes it before a password is typed. Agents and rogue extensions move like machines: perfectly straight cursor paths at thousands of pixels per second, with zero jitter. PhishGuard spots that pattern on an unverified form and halts the submission.",
  },
  {
    id: "item-2",
    question: "Chrome already has Safe Browsing. Why do I need this?",
    answer:
      "Safe Browsing relies on lists of known-bad sites, so a domain registered ten minutes ago—or a trap injected by a script—slips through until someone reports it. PhishGuard judges the live page on your device, so it doesn't need to have seen the site before. Keep both on; they complement each other.",
  },
  {
    id: "item-bfsi",
    question: "Is it a fit for banks and financial institutions?",
    answer:
      "Yes. Most account takeover starts on a fake banking or payment login, and that is the moment PhishGuard judges. Financial institutions can roll it out to staff handling critical business workloads, and recommend it to customers, as an extra fraud detection and risk management layer next to existing controls. Because analysis runs on the device and keystrokes are never recorded, no browsing data has to be shared to get protection.",
  },
  {
    id: "item-3",
    question: "Does it record what I type?",
    answer:
      "No. It measures only the time between key presses and how long keys are held, grouped into broad categories like letter, backspace and control. The characters themselves are never read or stored, and the data schemas reject any attempt to include them.",
  },
  {
    id: "item-4",
    question: "Does anything get sent to a server?",
    answer: `Not unless you ask. If a page is flagged as suspicious, you can request a cloud second opinion from the toolbar. That sends the page URL, page-structure signals and interaction timing—never typed characters—to the PhishGuard gateway, where a Gemini agent analyzes them. If you tick "Include a screenshot", a ${facts.screenshotUpload} image of the visible tab is sent once for that check; the gateway forwards it to Google Gemini for analysis and PhishGuard doesn't store it. Model updates are downloaded and hash-checked; nothing about your browsing is uploaded.`,
  },
  {
    id: "item-screen",
    question: "Does PhishGuard look at my screen?",
    answer: `Only on pages with a password field, only the visible tab, and only as a ${facts.visionInput} thumbnail in memory that's discarded right after scoring. It's never saved or uploaded—unless you tick "Include a screenshot" for a cloud check.`,
  },
  {
    id: "item-5",
    question: "What do I need to run it?",
    answer:
      "Any Chromium browser with Manifest V3: Chrome 113+, Brave, Edge or Opera. It uses your GPU through WebGPU when available and falls back to WASM on older machines.",
  },
  {
    id: "item-6",
    question: "Will it slow down my browser or drain my battery?",
    answer:
      `The ${fmtKB(facts.modelSizeBytes)} model runs on your device using WebGPU when available, with a WASM fallback. Routine checks do not require a server round-trip; cloud verification only runs when you request it.`,
  },
  {
    id: "item-7",
    question: "Does it work offline?",
    answer:
      "Yes. The model ships inside the extension and runs entirely on your device. The optional cloud check is the only feature that needs a connection.",
  },
];

export function FAQ() {
  const FAQS = getFaqs(useProductFacts());
  return (
    <section
      id="faq"
      data-page
      className="relative overflow-x-clip border-t lg:flex lg:min-h-[100svh] lg:flex-col lg:justify-center border-white/[0.08] py-[clamp(6rem,10vw,10rem)]"
    >
      <div className="container-x grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
        <SectionHeader
          stacked
          label="FAQ"
          title="Questions, answered."
          lead="Privacy, performance, and how PhishGuard fits next to what you already use."
          className="lg:sticky lg:top-28 lg:col-span-4 lg:self-start"
        />

        <Accordion type="single" collapsible className="w-full border-t border-white/[0.08] lg:col-span-8">
          {FAQS.map((item) => (
            <AccordionItem key={item.id} value={item.id}>
              <AccordionTrigger className="text-lg sm:text-xl">{item.question}</AccordionTrigger>
              <AccordionContent className="max-w-2xl text-base">{item.answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

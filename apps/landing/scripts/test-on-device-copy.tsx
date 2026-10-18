import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsStrip } from "../components/StatsStrip";
import { Benefits } from "../components/Benefits";
import { Comparison } from "../components/Comparison";
import { HowItWorks } from "../components/HowItWorks";
import { ModelLifecycle } from "../components/ModelLifecycle";
import { DEFAULT_FACTS, fmtPct } from "../lib/facts";
import { getPopupStates } from "../lib/popupStates";

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string) => readFileSync(resolve(here, relativePath), "utf8");

const MS_CLAIM = /\d(?:\.\d+)?\s*ms\b/i;

const renderText = (element: ReactElement) =>
  renderToStaticMarkup(element).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("StatsStrip leads with on-device analysis instead of a verdict latency", () => {
  const text = renderText(createElement(StatsStrip));
  assert.match(text, /On-device analysis/);
  assert.match(text, /Runs in your browser/);
  assert.doesNotMatch(text, /Time to verdict/i);
  assert.doesNotMatch(text, /latency/i);
  assert.doesNotMatch(text, MS_CLAIM);
});

test("Benefits describes on-device inference without latency specs", () => {
  const text = renderText(createElement(Benefits));
  assert.match(text, /directly on your device—no round-trip to any server/);
  assert.match(text, /Inference\s+On-device/);
  assert.doesNotMatch(text, /\bLatency\b/);
  assert.doesNotMatch(text, MS_CLAIM);
});

test("Comparison describes page analysis as on-device without timing", () => {
  const text = renderText(createElement(Comparison));
  assert.match(text, /Page analysis/);
  assert.match(text, /How the verdict is produced/);
  assert.match(text, /On-device, in your browser/);
  assert.doesNotMatch(text, /Time to a verdict/i);
  assert.doesNotMatch(text, MS_CLAIM);
});

test("HowItWorks headline and vision scene drop duration claims", () => {
  const text = renderText(createElement(HowItWorks));
  assert.match(text, /Three signals\. One verdict\. On-device\./);
  assert.match(text, /Cloud check/);
  assert.match(text, /A Gemini agent built on Google ADK reviews the same three signals/);
  assert.match(text, /if Gemini is unavailable the gateway(?:'|&#x27;)s own checks answer instead/);
  assert.match(text, /The thumbnail is used in memory and is never saved\./);
  assert.doesNotMatch(text, /Under \d+\s*ms/i);
  assert.doesNotMatch(text, /for milliseconds/i);
  assert.doesNotMatch(text, MS_CLAIM);
});

test("ModelLifecycle distillation keeps only the accuracy gate", () => {
  const text = renderText(createElement(ModelLifecycle));
  assert.match(text, /runs on-device in your browser/);
  assert.match(text, /accuracy gate/);
  assert.doesNotMatch(text, /instantly/i);
  assert.doesNotMatch(text, /ms gates/i);
  assert.doesNotMatch(text, MS_CLAIM);
});

test("popup states report model accuracy without a parenthesized latency", () => {
  const states = getPopupStates(DEFAULT_FACTS);
  for (const key of ["safe", "suspicious", "blocked"] as const) {
    assert.equal(states[key].model.accuracy, fmtPct(DEFAULT_FACTS.accuracy));
    assert.doesNotMatch(states[key].model.accuracy, /ms|\(/);
  }
});

test("facts no longer expose landing latency fields or millisecond formatters", () => {
  const facts = readSource("../lib/facts.ts");
  assert.doesNotMatch(facts, /latencyMs|latencyGateMs|fmtMs|ceilMs/);
});

test("hidden copy sources drop timing claims", () => {
  const faq = readSource("../components/FAQ.tsx");
  assert.match(faq, /model runs on your device using WebGPU when available, with a WASM fallback/);
  assert.match(faq, /cloud verification only runs when you request it/);
  assert.match(faq, /forwards it to Google Gemini for analysis/);
  assert.doesNotMatch(faq, /discarded after scoring\. Model updates/);
  assert.doesNotMatch(faq, /verdict in under|latencyMs|ceilMs/);

  const howItWorks = readSource("../components/HowItWorks.tsx");
  assert.match(howItWorks, /The thumbnail is used in memory and is never saved\./);
  assert.match(howItWorks, /Three signals\. One verdict\. On-device\./);
  assert.doesNotMatch(howItWorks, /for milliseconds|latencyMs|ceilMs/);

  const radar = readSource("../components/MLModelRadar.tsx");
  assert.match(radar, /ON-DEVICE/);
  assert.doesNotMatch(radar, /\d+\s*ms\s+EVAL/i);

  const install = readSource("../components/InstallGuide.tsx");
  assert.match(install, /Install in a few steps/);
  assert.doesNotMatch(install, /Install in 30 seconds/);
});

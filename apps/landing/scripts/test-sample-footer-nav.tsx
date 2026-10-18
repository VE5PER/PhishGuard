import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SampleFooterNav } from "../components/SampleFooterNav";

const sampleCases = [
  { currentSample: 1, tone: "light" },
  { currentSample: 2, tone: "light" },
  { currentSample: 3, tone: "dark" },
] as const;

for (const { currentSample, tone } of sampleCases) {
  test(`sample ${currentSample} footer links to the other samples`, () => {
    const html = renderToStaticMarkup(
      createElement(SampleFooterNav, { currentSample, tone }),
    );
    const nav = html.match(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/);
    assert.ok(nav, "expected sample navigation");
    assert.match(nav[1], /aria-label="Other sample pages"/);

    const links = [...nav[2].matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map(([, attributes, content]) => ({
      href: attributes.match(/\bhref="([^"]+)"/)?.[1],
      label: content.replace(/<[^>]+>/g, "").trim(),
      attributes,
    }));
    const expectedSamples = [1, 2, 3].filter((sample) => sample !== currentSample);

    assert.equal(links.length, 2);
    assert.deepEqual(
      links.map(({ href }) => href),
      expectedSamples.map((sample) => `/sample${sample}`),
    );
    assert.deepEqual(
      links.map(({ label }) => label),
      expectedSamples.map((sample) => `Sample ${sample}`),
    );
    assert.ok(links.every(({ href }) => href !== `/sample${currentSample}`));
    assert.ok(links.every(({ attributes }) => attributes.includes("min-h-11")));
    assert.ok(links.every(({ attributes }) => attributes.includes("focus-visible:outline")));
    assert.match(html, new RegExp(tone === "dark" ? "text-\\[#a9bac8\\]" : "text-\\[#586f61\\]"));
  });
}

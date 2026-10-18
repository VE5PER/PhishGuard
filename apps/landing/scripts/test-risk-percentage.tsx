import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PopupReplica } from "../components/replica/PopupReplica";
import type { PopupState, PopupVerdict } from "../lib/popupStates";

const here = dirname(fileURLToPath(import.meta.url));
const popupHtml = readFileSync(resolve(here, "../../extension/popup/popup.html"), "utf8");
const popupTs = readFileSync(resolve(here, "../../extension/popup/popup.ts"), "utf8");

const makePopupState = (verdict: PopupVerdict, score: number): PopupState => ({
  verdict,
  score,
  domain: "example.test",
  signals: [
    { label: "Interaction", status: "ok", detail: "Natural movement" },
    { label: "Page", status: "ok", detail: "No hidden elements" },
    { label: "Vision", status: "ok", detail: "Layout matches" },
  ],
  cloudDescription: "Cloud verification is optional.",
  model: {
    version: "v1",
    source: "Local",
    accuracy: "99%",
    hash: "12345678",
    clientDb: "SQLite",
    extensionVersion: "v1",
  },
});

test("PopupReplica renders sample risk states as percentages", () => {
  const samples: Array<[PopupVerdict, number, string]> = [
    ["safe", 0.04, "4%"],
    ["ambiguous", 0.48, "48%"],
    ["block", 0.94, "94%"],
  ];

  for (const [verdict, score, expected] of samples) {
    const html = renderToStaticMarkup(
      createElement(PopupReplica, { state: makePopupState(verdict, score) }),
    );
    assert.match(html, /RISK PERCENTAGE/);
    const scoreText = html.match(/data-id="risk-score">([^<]*)<\/div>/)?.[1];
    assert.equal(scoreText, expected);
    assert.doesNotMatch(scoreText ?? "", /\d\.\d{2}/);
  }
});

test("extension popup labels and formats percentages without scaling its scanning placeholder", () => {
  assert.match(popupHtml, /<span class="score-meta-label">RISK PERCENTAGE<\/span>/);
  assert.match(popupHtml, /<span id="risk-score" class="score-val">5%<\/span>/);
  assert.match(popupTs, /riskScore\.textContent = `\$\{scaledScore\}%`;/);
  assert.match(popupTs, /riskScore\.textContent = '\.\.\.';/);
});

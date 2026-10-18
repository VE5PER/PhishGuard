import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaygroundRunResponseSchema, PlaygroundScenarioSchema } from "@phishguard/types";
import { getDemoRun } from "../lib/playground/demoResults";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../backend/src/phishguard_backend/playground/scenarios");

async function loadScenarios() {
  return ["brand-impersonation", "ambiguous-sso", "benign-google"].map((id) => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, `${id}.json`), "utf8"));
    const jpeg = readFileSync(resolve(FIXTURES, `${id}.jpg`)).toString("base64");
    return PlaygroundScenarioSchema.parse({
      id,
      title: raw.title,
      tagline: raw.tagline,
      payload: {
        ...raw.payload,
        telemetryId: "6f1b0a6e-5f0e-4a39-9c0c-0d0a5c1a7a11",
        clientRiskScore: 0,
        clientTimestamp: "2026-01-01T00:00:00.000Z",
        screenshotBase64: `data:image/jpeg;base64,${jpeg}`,
      },
    });
  });
}

test("getDemoRun parses against PlaygroundRunResponseSchema for every scenario", async () => {
  const scenarios = await loadScenarios();
  assert.deepEqual(scenarios.map((s) => s.id), ["brand-impersonation", "ambiguous-sso", "benign-google"]);
  const expected: Record<string, { route: string; evidence: string; gemini: string }> = {
    "brand-impersonation": { route: "BLOCK", evidence: "BLOCK", gemini: "BLOCK" },
    "ambiguous-sso": { route: "AMBIGUOUS", evidence: "WARN", gemini: "WARN" },
    "benign-google": { route: "SAFE", evidence: "ALLOW", gemini: "ALLOW" },
  };
  for (const scenario of scenarios) {
    const { edge, run } = getDemoRun(scenario);
    const parsed = PlaygroundRunResponseSchema.parse(run);
    assert.equal(edge.route, expected[scenario.id].route);
    assert.equal(parsed.evidence.verdict.actionOverride, expected[scenario.id].evidence);
    assert.equal(parsed.gemini.verdict.actionOverride, expected[scenario.id].gemini);
    assert.equal(parsed.payload.clientRiskScore, edge.fusedScore);
    assert.equal(parsed.payload.telemetryId, parsed.gemini.verdict.telemetryId);
    assert.equal(parsed.payload.telemetryId, parsed.evidence.verdict.telemetryId);
    assert.equal(parsed.gemini.trace.status, "ok");
    assert.equal(parsed.gemini.cached, false);
    for (const reason of [...parsed.gemini.verdict.explanationReasons, ...(parsed.gemini.verdict.screenAnalysis?.reasons ?? [])]) {
      assert.ok(reason.length <= 300, `reason too long: ${reason.length}`);
    }
    assert.notEqual(getDemoRun(scenario).run.payload.telemetryId, run.payload.telemetryId);
  }
});

test("benign-google Gemini verdict mirrors the evidence baseline and the registry rail", async () => {
  const scenario = (await loadScenarios()).find((s) => s.id === "benign-google")!;
  const { run } = getDemoRun(scenario);
  const gemini = run.gemini.verdict;
  const evidence = run.evidence.verdict;
  assert.equal(gemini.isPhishing, false);
  assert.equal(gemini.actionOverride, evidence.actionOverride);
  assert.equal(gemini.confidence, evidence.confidence);
  assert.equal(gemini.riskScore, evidence.riskScore);
  assert.deepEqual(gemini.explanationReasons.slice(0, evidence.explanationReasons.length), evidence.explanationReasons);
  assert.ok(gemini.explanationReasons.some((r) => r.startsWith("Brand claim contradicted by registry")));
  assert.equal(gemini.screenAnalysis?.screenRiskScore, Math.min(0.04, evidence.riskScore ?? 0.04));
});

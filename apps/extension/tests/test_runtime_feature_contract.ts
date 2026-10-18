import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { InteractionTelemetryPayload, PointerEventPoint } from '@phishguard/types';
import { prepareTrajectory } from '../src/background/trajectory-preprocessor.ts';
import { BRAND_DOMAINS, PAGE_CONTEXT_FEATURES, preparePageContext } from '../src/background/page-context.ts';
import { composeRisk, evaluateEvidenceRisk } from '../src/background/risk-policy.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/runtime_features_v2.json', import.meta.url), 'utf8')) as {
  brands: Record<string, string[]>;
  features: string[];
  trajectories: Array<{
    name: string; points: PointerEventPoint[]; expected: number[]; available: boolean;
    validPointCount: number; durationMs: number; invalidReason: string | null;
  }>;
  pages: Array<{
    payload: InteractionTelemetryPayload; context: number[]; available: boolean;
    evidenceScore: number; ruleIds: string[];
  }>;
};

test('canonical trajectory tensors agree with Python at every channel and timestep', () => {
  for (const entry of fixture.trajectories) {
    const actual = prepareTrajectory(entry.points);
    assert.equal(actual.available, entry.available, entry.name);
    assert.equal(actual.validPointCount, entry.validPointCount, entry.name);
    assert.equal(actual.durationMs, entry.durationMs, entry.name);
    assert.equal(actual.invalidReason, entry.invalidReason, entry.name);
    for (let i = 0; i < entry.expected.length; i++) {
      assert.ok(Math.abs(actual.tensor[i] - entry.expected[i]) < 1e-6, `${entry.name}:${i}`);
    }
  }
});

test('page context, domain authorization registry, and policy agree with Python', () => {
  assert.deepEqual(BRAND_DOMAINS, fixture.brands);
  assert.deepEqual([...PAGE_CONTEXT_FEATURES], fixture.features);
  const trajectory = prepareTrajectory(fixture.trajectories.find((entry) => entry.name === 'sixteen')!.points);
  for (const entry of fixture.pages) {
    const page = preparePageContext(entry.payload, trajectory, true);
    assert.equal(page.available, entry.available);
    assert.deepEqual([...page.context], entry.context);
    const risk = evaluateEvidenceRisk(page);
    assert.equal(risk.score, entry.evidenceScore);
    assert.deepEqual(risk.ruleIds, entry.ruleIds);
  }
});

test('routing is exact at the inclusive ambiguous boundaries and rejects nonfinite model predictions', () => {
  for (const [value, expected] of [[0.149999, 'SAFE'], [0.15, 'AMBIGUOUS'], [0.85, 'AMBIGUOUS'], [0.850001, 'BLOCK']] as const) {
    assert.equal(composeRisk(value, 0.05).action, expected);
  }
  assert.deepEqual(composeRisk(Number.NaN, 0.05), { score: 0.05, action: 'SAFE' });
});

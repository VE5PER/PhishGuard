import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModelMetadataSchema,
  type InteractionTelemetryPayload,
  type ModelMetadata,
} from '@phishguard/types';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const candidateDir = resolve(
  repoRoot,
  'apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate',
);
const candidatePath = resolve(candidateDir, 'student_model.onnx');
const reportPath = resolve(candidateDir, 'evaluation-with-source.json');
const fixturePath = resolve(candidateDir, 'runtime-fixture.json');
const runtimeEvidencePath = resolve(candidateDir, 'runtime-evidence.json');

// These artifacts are produced out-of-band (frozen R3 checkpoint + a landing build).
// Skip the test instead of failing when they are absent (e.g. clean CI checkout).
const requiredFixtures = [
  candidatePath,
  reportPath,
  fixturePath,
  runtimeEvidencePath,
  resolve(repoRoot, 'apps/landing/out/sample1/index.html'),
  resolve(repoRoot, 'apps/landing/out/sample2/index.html'),
  resolve(repoRoot, 'apps/landing/out/sample3/index.html'),
];
const missingFixtures = requiredFixtures.filter((p) => !existsSync(p));
const skipReason = missingFixtures.length
  ? `missing out-of-band fixtures: ${missingFixtures.join(', ')}`
  : false;

// Run after building the landing app; these are the pages actually served by the backend.
// 1. Read static testbench files
function assertExportedSample(number: 1 | 2 | 3): string {
  const html = readFileSync(resolve(repoRoot, `apps/landing/out/sample${number}/index.html`), 'utf8');
  const bodyStart = html.indexOf('<body');
  const bodyEnd = html.indexOf('<script', bodyStart);
  const body = html.slice(bodyStart, bodyEnd);
  assert.ok(body, `sample${number} must contain exported page content`);
  assert.match(body, /<input\b[^>]*\btype="password"/i);
  assert.doesNotMatch(body, /<input\b[^>]*\btype="password"[^>]*\bvalue=/i);
  if (number === 2) assert.match(body, /sample2-trap/);
  if (number === 3) {
    assert.match(body, /sample3-password-trap/);
    assert.match(body, /id="trap-layer"/);
    assert.match(body, /<iframe\b[^>]*src="https:\/\/example\.com"/);
  }
  return body;
}

test(
  'r3 ONNX-WASM inference matches frozen runtime cases and exported sample decisions',
  { skip: skipReason },
  async () => {
  const candidate = readFileSync(candidatePath);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    model_sha256: string;
    input_contract: ModelMetadata['inputContract'];
    passed_all_gates: boolean;
    corpus_digest: string;
    policy_version: string;
    latency_ms_average: number;
    metrics: {
      accuracy: number;
      f1: number;
      false_positive_rate: number;
      benign_warning_count: number;
      critical_miss_count: number;
    };
    independent_test_groups: number;
  };
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    format: string;
    modelSha256: string;
    cases: Array<{
      name: string;
      pair: string | null;
      expectedAction: string;
      expectedModelScore: number;
      payload: InteractionTelemetryPayload;
      visualPresent: boolean;
    }>;
  };
  const runtimeEvidence = JSON.parse(readFileSync(runtimeEvidencePath, 'utf8')) as {
    peakRssMb: number;
  };
  const candidateHash = createHash('sha256').update(candidate).digest('hex');
  assert.equal(candidateHash, report.model_sha256);
  assert.equal(candidateHash, fixture.modelSha256);
  assert.equal(fixture.format, 'student-runtime-fixture-v2');

  const modelBuffer = candidate.buffer.slice(candidate.byteOffset, candidate.byteOffset + candidate.byteLength);
  // 2. Initialize and hot-swap on-device ONNX engine with real student_model.onnx
  const metadata = ModelMetadataSchema.parse({
    version: '0.0.0-candidate',
    name: 'unreleased-frozen-candidate-test',
    architecture: 'student-v2',
    sha256: report.model_sha256,
    fileSizeBytes: candidate.byteLength,
    releasedAt: new Date().toISOString(),
    minExtensionVersion: '0.1.0',
    features: ['x', 'y', 'dx', 'dy', 'v', 'theta', 'viewport_rgb_64', 'page_context_16'],
    metrics: {
      accuracy: report.metrics.accuracy,
      f1Score: report.metrics.f1,
      latencyMs: report.latency_ms_average,
      memoryBudgetMb: runtimeEvidence.peakRssMb,
    },
    changelog: [],
    downloadUrl: 'candidate-local-only',
    inputContract: report.input_contract,
    validationSummary: {
      passedAllGates: report.passed_all_gates,
      modelSha256: report.model_sha256,
      corpusDigest: report.corpus_digest,
      reportSha256: '108010413752248bf5ea86b47e28e26a4a4e0976795f10452d21af2bbc0c4702',
      inputContractIdentifier: report.input_contract?.identifier,
      policyVersion: report.policy_version,
      basis: 'repository_synthetic',
      falsePositiveRate: report.metrics.false_positive_rate,
      benignWarningCount: report.metrics.benign_warning_count,
      criticalMissCount: report.metrics.critical_miss_count,
      independentTestGroups: report.independent_test_groups,
    },
  });
  const engine = new OnDeviceStudentEngine();
  try {
    assert.equal(await engine.hotSwapModel(modelBuffer, metadata, 'LOCAL_BUNDLED'), true);

    const routes: string[] = [];
    const pairScores = new Map<string, number[]>();
    for (const entry of fixture.cases) {
      if (entry.name.startsWith('sample')) {
        const sampleNumber = Number(entry.name.match(/^sample([123])/)?.[1]) as 1 | 2 | 3;
        assertExportedSample(sampleNumber);
      }
      const visual = entry.visualPresent ? new Float32Array(3 * 64 * 64).fill(1) : null;
      const { result, breakdown } = await engine.predictDetailed(entry.payload, visual);
      const modelScore = breakdown.fused.modelScore;
      assert.notEqual(modelScore, null, `${entry.name} must execute the candidate graph`);
      assert.ok(
        Math.abs((modelScore ?? 0) - entry.expectedModelScore) <= 1e-4,
        `${entry.name} must match its frozen model reference`,
      );
      assert.equal(result.routeAction, entry.expectedAction, `${entry.name} route`);
      assert.equal(breakdown.fused.modelHash, report.model_sha256);
      assert.equal(breakdown.fused.inputContractIdentifier, 'student-v2');
      routes.push(result.routeAction);
      if (entry.pair !== null) {
        const scores = pairScores.get(entry.pair) ?? [];
        scores.push(modelScore ?? 0);
        pairScores.set(entry.pair, scores);
      }
    }

    assert.equal(routes.length, 13);
    for (const scores of pairScores.values()) {
      assert.equal(scores.length, 2);
      assert.ok(Math.abs(scores[0] - scores[1]) <= 1e-6);
    }
  } finally {
    const session = (engine as unknown as { session: { release: () => Promise<void> } | null }).session;
    await session?.release();
  }
});

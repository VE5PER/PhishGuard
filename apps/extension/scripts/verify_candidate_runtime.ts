import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import type { InteractionTelemetryPayload } from '@phishguard/types';
import { prepareTrajectory } from '../src/background/trajectory-preprocessor.js';
import { preparePageContext } from '../src/background/page-context.js';
import { composeRisk, evaluateEvidenceRisk } from '../src/background/risk-policy.js';

const option = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Required option ${name}`);
  return value;
};
const modelPath = option('--model');
const fixturePath = option('--fixture');
const outputPath = option('--output');
if (existsSync(outputPath)) throw new Error('Runtime acceptance evidence is immutable');
const bytes = readFileSync(modelPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  format: string;
  modelSha256: string;
  cases: Array<{
    name: string; pair: string | null; expectedAction: string; payload: InteractionTelemetryPayload;
    visualPresent: boolean; expectedModelScore: number;
  }>;
};
if (fixture.format !== 'student-runtime-fixture-v2' || fixture.modelSha256 !== sha256) {
  throw new Error('Runtime fixture/model mismatch');
}
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  { executionProviders: ['wasm'] }
);
const expectedNames = ['page_context', 'trajectory', 'visual'];
if (JSON.stringify([...session.inputNames].sort()) !== JSON.stringify(expectedNames)) {
  throw new Error('Unexpected model signature');
}
const rows: Array<{ name: string; pair: string | null; expectedAction: string; actualAction: string; modelScore: number; score: number; cpuWebError: number }> = [];
for (const item of fixture.cases) {
  const trajectory = prepareTrajectory(item.payload.pointerSeries);
  const frame = item.visualPresent ? new Float32Array(3 * 64 * 64).fill(1) : null;
  const page = preparePageContext(item.payload, trajectory, frame !== null);
  const output = await session.run({
    trajectory: new ort.Tensor('float32', trajectory.available ? trajectory.tensor : new Float32Array(128 * 6), [1, 128, 6]),
    visual: new ort.Tensor('float32', frame ?? new Float32Array(3 * 64 * 64), [1, 3, 64, 64]),
    page_context: new ort.Tensor('float32', page.context, [1, 16]),
  });
  const modelScore = Number(output.risk_score.data[0]);
  if (!Number.isFinite(modelScore) || modelScore < 0 || modelScore > 1) throw new Error('Invalid model output');
  const composed = composeRisk(modelScore, evaluateEvidenceRisk(page).score);
  rows.push({
    name: item.name, pair: item.pair, expectedAction: item.expectedAction, actualAction: composed.action,
    modelScore, score: composed.score, cpuWebError: Math.abs(modelScore - item.expectedModelScore),
  });
}
await session.release();
const maxCpuWebError = Math.max(...rows.map((row) => row.cpuWebError));
let maxProtocolDelta = 0;
for (const pair of new Set(rows.map((row) => row.pair).filter((value): value is string => value !== null))) {
  const grouped = rows.filter((row) => row.pair === pair);
  if (grouped.length !== 2) throw new Error('Missing protocol counterpart');
  maxProtocolDelta = Math.max(maxProtocolDelta, Math.abs(grouped[0].modelScore - grouped[1].modelScore));
}
const failures = rows.filter((row) => row.expectedAction !== row.actualAction).map((row) => row.name);
if (maxCpuWebError > 1e-4) failures.push('cpu_web_parity');
if (maxProtocolDelta > 1e-6) failures.push('protocol_invariance');
const report = {
  format: 'student-runtime-acceptance-v2', modelSha256: sha256, passed: failures.length === 0,
  failures, maxCpuWebError, maxProtocolDelta, cases: rows,
  scope: 'Constructed local fixtures through onnxruntime-web; no real-site observation or browser RAM measurement',
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;

import { OnDeviceStudentEngine } from '../src/background/onnx-engine.js';
import type { InteractionTelemetryPayload, ModelMetadata } from '@phishguard/types';

type RuntimeCase = {
  name: string;
  expectedAction: string;
  expectedModelScore: number;
  payload: InteractionTelemetryPayload;
  visualPresent: boolean;
};

let engine: OnDeviceStudentEngine | null = null;
let cases: RuntimeCase[] = [];

async function initialize(): Promise<{ modelSha256: string; cases: number }> {
  const [bytes, fixture, metadata] = await Promise.all([
    fetch(chrome.runtime.getURL('models/student_model.onnx')).then((response) => response.arrayBuffer()),
    fetch(chrome.runtime.getURL('runtime-fixture.json')).then((response) => response.json()) as Promise<{
      modelSha256: string; cases: RuntimeCase[];
    }>,
    fetch(chrome.runtime.getURL('models/student_model.metadata.json')).then((response) => response.json()) as Promise<ModelMetadata>,
  ]);
  if (fixture.modelSha256 !== metadata.sha256 || fixture.cases.length !== 13) {
    throw new Error('Frozen fixture/model identity mismatch');
  }
  engine = new OnDeviceStudentEngine();
  if (!(await engine.hotSwapModel(bytes, metadata, 'LOCAL_BUNDLED'))) {
    throw new Error('Candidate activation failed in the browser worker');
  }
  cases = fixture.cases;
  return { modelSha256: metadata.sha256, cases: cases.length };
}

async function measure(): Promise<{
  timingsMs: number[];
  maxCpuWebError: number;
  cases: Array<{ name: string; action: string; modelScore: number }>;
}> {
  if (!engine?.isReady()) throw new Error('The browser worker model is unavailable');
  const timingsMs: number[] = [];
  const results: Array<{ name: string; action: string; modelScore: number }> = [];
  let maxCpuWebError = 0;
  for (const entry of cases) {
    const visual = entry.visualPresent ? new Float32Array(3 * 64 * 64).fill(1) : null;
    for (let iteration = 0; iteration < 10; iteration++) {
      const start = performance.now();
      const { result, breakdown } = await engine.predictDetailed(entry.payload, visual);
      timingsMs.push(performance.now() - start);
      const modelScore = breakdown.fused.modelScore;
      if (modelScore === null || result.routeAction !== entry.expectedAction) {
        throw new Error(`Unexpected browser inference route for ${entry.name}`);
      }
      const error = Math.abs(modelScore - entry.expectedModelScore);
      if (error > 1e-4 || !Number.isFinite(error)) throw new Error(`Browser model parity failed for ${entry.name}`);
      maxCpuWebError = Math.max(maxCpuWebError, error);
      if (iteration === 0) results.push({ name: entry.name, action: result.routeAction, modelScore });
    }
  }
  return { timingsMs, maxCpuWebError, cases: results };
}

(globalThis as unknown as {
  phishguardRuntimeProbe: { initialize: typeof initialize; measure: typeof measure };
}).phishguardRuntimeProbe = { initialize, measure };

chrome.runtime.onInstalled.addListener(() => {});
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, respond) => {
  if (message.type !== 'PHISHGUARD_RUNTIME_PROBE_READY') return false;
  respond({ ready: true });
  return false;
});

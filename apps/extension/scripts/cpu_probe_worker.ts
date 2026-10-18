import * as ort from 'onnxruntime-web';
import { OnDeviceStudentEngine } from '../src/background/onnx-engine.js';
import type { InteractionTelemetryPayload, ModelMetadata } from '@phishguard/types';

interface FrozenCase {
  name: string;
  payload: InteractionTelemetryPayload;
  visualPresent: boolean;
  feeds: Record<string, number[]>;
  nativeScores: Record<string, number>;
  evidenceScore: number;
  modelEligible: boolean;
}

interface FrozenFixture {
  format: string;
  inputShapes: Record<string, number[]>;
  sourceModelSha256: string;
  candidateModelSha256: string;
  cases: FrozenCase[];
}

interface ProbeConfig {
  runtime: 'wasm' | 'jsep';
  mode: 'engine' | 'graph';
  modelSha256: string;
}

let session: ort.InferenceSession | null = null;
let engine: OnDeviceStudentEngine | null = null;
let fixture: FrozenFixture;
let config: ProbeConfig;
let frozenFeeds: Array<Record<string, Float32Array>> = [];

async function initialize() {
  const start = performance.now();
  const [model, fixtureResponse, configResponse] = await Promise.all([
    fetch(chrome.runtime.getURL('models/student_model.onnx')).then((response) => response.arrayBuffer()),
    fetch(chrome.runtime.getURL('fixture.json')).then((response) => response.json()) as Promise<FrozenFixture>,
    fetch(chrome.runtime.getURL('probe-config.json')).then((response) => response.json()) as Promise<ProbeConfig>,
  ]);
  fixture = fixtureResponse;
  config = configResponse;
  if (fixture.format !== 'student-cpu-frozen-feeds-v1' ||
    ![fixture.sourceModelSha256, fixture.candidateModelSha256].includes(config.modelSha256)) {
    throw new Error('Frozen fixture/model identity mismatch');
  }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', model)))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  if (hash !== config.modelSha256) throw new Error('Probe model bytes changed');
  if (config.mode === 'engine') {
    const metadata = await fetch(chrome.runtime.getURL('models/student_model.metadata.json'))
      .then((response) => response.json()) as ModelMetadata;
    engine = new OnDeviceStudentEngine();
    if (!(await engine.hotSwapModel(model, metadata, 'LOCAL_BUNDLED'))) {
      throw new Error('Production engine activation failed');
    }
    session = (engine as unknown as { session: ort.InferenceSession }).session;
  } else {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const binary = config.runtime === 'wasm'
      ? 'ort-wasm-simd-threaded.wasm' : 'ort-wasm-simd-threaded.jsep.wasm';
    ort.env.wasm.wasmBinary = await fetch(chrome.runtime.getURL(`assets/${binary}`))
      .then((response) => response.arrayBuffer());
    ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL(`assets/${binary}`) };
    session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
  }
  if (!session ||
    [...session.inputNames].sort().join(',') !== Object.keys(fixture.inputShapes).sort().join(',')) {
    throw new Error('Probe graph signature mismatch');
  }
  frozenFeeds = fixture.cases.map((entry) => Object.fromEntries(
    Object.entries(entry.feeds).map(([name, values]) => {
      const shape = fixture.inputShapes[name];
      if (!shape || shape.reduce((product, dimension) => product * dimension, 1) !== values.length ||
        values.some((value) => !Number.isFinite(value))) throw new Error('Invalid frozen tensor');
      return [name, new Float32Array(values)];
    })
  ));
  return {
    initializationMs: performance.now() - start,
    modelSha256: hash,
    cases: fixture.cases.length,
    provider: 'wasm',
    threads: ort.env.wasm.numThreads,
    mode: config.mode,
  };
}

async function graphRun(index: number) {
  if (!session) throw new Error('Probe is not initialized');
  const inputs = Object.fromEntries(Object.entries(frozenFeeds[index])
    .map(([name, values]) => [name, new ort.Tensor('float32', values, fixture.inputShapes[name])]));
  let outputs: Record<string, ort.Tensor> | undefined;
  try {
    const start = performance.now();
    outputs = await session.run(inputs);
    const elapsed = performance.now() - start;
    const score = Number(outputs.risk_score.data[0]);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid browser output');
    const expected = fixture.cases[index].nativeScores[config.modelSha256];
    if (expected === undefined || Math.abs(score - expected) > 1e-4) {
      throw new Error(`Native/browser parity failed: ${fixture.cases[index].name}`);
    }
    return { elapsed, score, error: Math.abs(score - expected) };
  } finally {
    for (const tensor of Object.values(inputs)) tensor.dispose();
    if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
  }
}

async function measure() {
  const timingsMs: number[] = [];
  const cases: Array<{ name: string; score: number; nativeError: number }> = [];
  const pipelineTimingsMs: number[] = [];
  for (let index = 0; index < 20; index++) await graphRun(index % fixture.cases.length);
  let maxCpuWebError = 0;
  for (let index = 0; index < 200; index++) {
    const caseIndex = index % fixture.cases.length;
    const result = await graphRun(caseIndex);
    timingsMs.push(result.elapsed);
    maxCpuWebError = Math.max(maxCpuWebError, result.error);
    if (index < fixture.cases.length) cases.push({
      name: fixture.cases[caseIndex].name, score: result.score, nativeError: result.error,
    });
  }
  if (engine) {
    for (let index = 0; index < fixture.cases.length; index++) {
      const entry = fixture.cases[index];
      const start = performance.now();
      const prediction = await engine.predictDetailed(entry.payload,
        entry.visualPresent ? frozenFeeds[index].visual : null);
      pipelineTimingsMs.push(performance.now() - start);
      const score = prediction.breakdown.fused.modelScore;
      if (entry.modelEligible && (score === null ||
        Math.abs(score - entry.nativeScores[config.modelSha256]) > 1e-4)) {
        throw new Error(`Production preprocessing parity failed: ${entry.name}`);
      }
    }
  }
  return { timingsMs, pipelineTimingsMs, maxCpuWebError, cases };
}

async function soak() {
  let maxCpuWebError = 0;
  for (let index = 0; index < 2000; index++) {
    const result = await graphRun(index % fixture.cases.length);
    maxCpuWebError = Math.max(maxCpuWebError, result.error);
  }
  return { runs: 2000, maxCpuWebError };
}

(globalThis as unknown as {
  phishguardCpuProbe: {
    initialize: typeof initialize;
    measure: typeof measure;
    soak: typeof soak;
  };
}).phishguardCpuProbe = { initialize, measure, soak };

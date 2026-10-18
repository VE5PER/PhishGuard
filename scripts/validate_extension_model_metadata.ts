import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ModelMetadataSchema } from '../packages/types/src/ts/models.ts';
import { PAGE_CONTEXT_FEATURES } from '../apps/extension/src/background/page-context.ts';
import { BUNDLED_BASELINE_METADATA } from '../apps/extension/src/background/onnx-engine.ts';

function fail(message: string): never {
  throw new Error(message);
}

function parseReleaseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareReleaseVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sameContract(actual: unknown): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const contract = actual as Record<string, unknown>;
  const expectedInputs: Array<[string, number[]]> = [
    ['trajectory', [128, 6]],
    ['visual', [3, 64, 64]],
    ['page_context', [16]],
  ];
  const inputs = Array.isArray(contract.inputs) ? contract.inputs : [];
  return contract.identifier === 'student-v2' &&
    contract.trajectoryPreprocessing === 'normalized-coordinate-derivatives-index-linear-v2' &&
    inputs.length === expectedInputs.length &&
    inputs.every((value, index) => {
      if (!value || typeof value !== 'object') return false;
      const input = value as Record<string, unknown>;
      const [name, shape] = expectedInputs[index];
      return input.name === name &&
        input.dtype === 'float32' &&
        JSON.stringify(input.shape) === JSON.stringify(shape);
    }) &&
    JSON.stringify(contract.contextFeatures) === JSON.stringify(PAGE_CONTEXT_FEATURES);
}

const [modelPath, metadataPath, validationDirectory, extensionVersion] = process.argv.slice(2);
if (!modelPath || !metadataPath || !validationDirectory || !extensionVersion) {
  fail('Usage: validate_extension_model_metadata.ts model metadata validation-directory extension-version');
}

const modelBytes = readFileSync(modelPath);
const modelHash = sha256(modelBytes);
const releasedLegacy = ModelMetadataSchema.parse(BUNDLED_BASELINE_METADATA);
if (process.argv.includes('--prepare-released-legacy') && !existsSync(metadataPath)) {
  if (modelHash !== releasedLegacy.sha256 || modelBytes.length !== releasedLegacy.fileSizeBytes) {
    fail('Metadata can only be recovered for the exact already-released legacy bundle');
  }
  writeFileSync(metadataPath, JSON.stringify(releasedLegacy, null, 2) + '\n', { flag: 'wx' });
}
const metadataResult = ModelMetadataSchema.safeParse(JSON.parse(readFileSync(metadataPath, 'utf8')));
if (!metadataResult.success) fail('Model metadata does not satisfy the shared strict schema');
const metadata = metadataResult.data;
if (metadata.sha256.toLowerCase() !== modelHash || metadata.fileSizeBytes !== statSync(modelPath).size) {
  fail('Model metadata does not match the ONNX binary');
}

const extensionVersionParts = parseReleaseVersion(extensionVersion);
const minimumVersionParts = parseReleaseVersion(metadata.minExtensionVersion);
if (
  !extensionVersionParts ||
  !minimumVersionParts ||
  compareReleaseVersions(extensionVersionParts, minimumVersionParts) < 0
) {
  fail('Extension version does not satisfy model minimum version');
}

const modelVersionParts = parseReleaseVersion(metadata.version);
if (!modelVersionParts || basename(validationDirectory) !== `v${metadata.version}`) {
  if (!process.argv.includes('--prepare-released-legacy') || metadata.version !== releasedLegacy.version) {
    fail('Model version does not match its validation directory');
  }
}
if (metadata.version === releasedLegacy.version) {
  if (JSON.stringify(metadata) !== JSON.stringify(releasedLegacy) ||
      modelHash !== releasedLegacy.sha256 ||
      metadata.inputContract != null || metadata.validationSummary != null) {
    fail('Legacy metadata must match the existing released descriptor without invented validation');
  }
  console.log(`Verified existing legacy model ${metadata.version}; no student-v2 validation is claimed`);
  process.exit(0);
}
if (!sameContract(metadata.inputContract)) fail('Model input contract is not canonical student-v2');

const reportPath = join(validationDirectory, 'evaluation-with-source.json');
const runtimePath = join(validationDirectory, 'runtime-acceptance.json');
const runtimeEvidencePath = join(validationDirectory, 'runtime-evidence.json');
const reportBytes = readFileSync(reportPath);
const runtimeBytes = readFileSync(runtimePath);
const runtime = JSON.parse(runtimeBytes.toString('utf8')) as Record<string, unknown>;
const runtimeEvidence = JSON.parse(readFileSync(runtimeEvidencePath, 'utf8')) as Record<string, unknown>;
const report = JSON.parse(reportBytes.toString('utf8')) as Record<string, unknown>;
const metrics = report.metrics && typeof report.metrics === 'object'
  ? report.metrics as Record<string, unknown>
  : undefined;
const gates = report.gates && typeof report.gates === 'object'
  ? report.gates as Record<string, unknown>
  : undefined;
const summary = metadata.validationSummary;
const accuracy = finiteNumber(metrics?.accuracy);
const f1 = finiteNumber(metrics?.f1);
const falsePositiveRate = finiteNumber(metrics?.false_positive_rate);
const brier = finiteNumber(metrics?.brier);
const benignWarnings = finiteNumber(metrics?.benign_warning_count);
const criticalMisses = finiteNumber(metrics?.critical_miss_count);
const averageLatency = finiteNumber(report.latency_ms_average);
const fileSizeMb = finiteNumber(report.file_size_mb);
const minimumAccuracy = finiteNumber(gates?.min_accuracy);
const minimumF1 = finiteNumber(gates?.min_f1);
const maximumFalsePositiveRate = finiteNumber(gates?.max_false_positive_rate);
const maximumBrier = finiteNumber(gates?.max_brier);
const maximumBenignWarnings = finiteNumber(gates?.max_benign_warning_count);
const maximumCriticalMisses = finiteNumber(gates?.max_critical_miss_count);
const maximumLatency = finiteNumber(gates?.max_latency_ms);
const maximumFileSizeMb = finiteNumber(gates?.max_file_size_mb);
const expectedGates = {
  min_accuracy: 0.95,
  min_f1: 0.95,
  max_false_positive_rate: 0.005,
  max_brier: 0.05,
  max_latency_ms: 40,
  max_file_size_mb: 80,
  max_benign_warning_count: 0,
  max_critical_miss_count: 0,
};
const expectedCases = new Map<string, string>();
for (const [name, action] of [
  ['sample1', 'SAFE'], ['sample2', 'AMBIGUOUS'], ['sample2_repeated', 'AMBIGUOUS'],
  ['sample3', 'BLOCK'], ['landing_white', 'SAFE'], ['brand_article', 'SAFE'],
]) {
  for (const scheme of ['http', 'https']) expectedCases.set(`${name}_${scheme}`, action);
}
expectedCases.set('synthetic_official_yahoo_login', 'SAFE');
const runtimeCases = Array.isArray(runtime.cases) ? runtime.cases : [];
const acceptanceNames = new Set(runtimeCases.map((row: unknown) =>
  row && typeof row === 'object' ? (row as Record<string, unknown>).name : undefined
));
const maxCpuWebError = finiteNumber(runtime.maxCpuWebError);
const maxProtocolDelta = finiteNumber(runtime.maxProtocolDelta);
const peakRssMb = finiteNumber(runtimeEvidence.peakRssMb);
const thresholds = report.thresholds && typeof report.thresholds === 'object'
  ? report.thresholds as Record<string, unknown> : undefined;

if (
  !summary ||
  !metrics ||
  !gates ||
  accuracy === null ||
  f1 === null ||
  falsePositiveRate === null ||
  brier === null ||
  benignWarnings === null ||
  criticalMisses === null ||
  averageLatency === null ||
  fileSizeMb === null ||
  minimumAccuracy === null ||
  minimumF1 === null ||
  maximumFalsePositiveRate === null ||
  maximumBrier === null ||
  maximumBenignWarnings === null ||
  maximumCriticalMisses === null ||
  maximumLatency === null ||
  maximumFileSizeMb === null ||
  Object.keys(gates).length !== Object.keys(expectedGates).length ||
  Object.entries(expectedGates).some(([key, value]) => gates[key] !== value) ||
  report.format !== 'student-context-evaluation-v2' ||
  report.policy_version !== 'evidence-v2' ||
  report.validation_basis !== 'repository_synthetic' ||
  !thresholds || Object.keys(thresholds).length !== 2 ||
  thresholds.safe !== 0.15 || thresholds.block !== 0.85 ||
  JSON.stringify(metadata.features) !== JSON.stringify([
    'x', 'y', 'dx', 'dy', 'v', 'theta', 'viewport_rgb_64', 'page_context_16',
  ]) ||
  accuracy < 0 || accuracy > 1 ||
  f1 < 0 || f1 > 1 ||
  falsePositiveRate < 0 || falsePositiveRate > 1 ||
  brier < 0 || brier > 1 ||
  averageLatency < 0 ||
  fileSizeMb !== modelBytes.length / (1024 * 1024) ||
  modelBytes.length >= 80 * 1024 * 1024 ||
  peakRssMb === null || peakRssMb <= 0 || peakRssMb >= 512 ||
  runtime.format !== 'student-runtime-acceptance-v2' ||
  runtimeCases.length !== expectedCases.size ||
  acceptanceNames.size !== expectedCases.size ||
  [...expectedCases.keys()].some((name) => !acceptanceNames.has(name)) ||
  runtimeCases.some((row: unknown) => {
    if (!row || typeof row !== 'object') return true;
    const entry = row as Record<string, unknown>;
    const expected = typeof entry.name === 'string' ? expectedCases.get(entry.name) : undefined;
    return expected === undefined || entry.expectedAction !== expected || entry.actualAction !== expected;
  }) ||
  maxCpuWebError === null || maxCpuWebError < 0 || maxCpuWebError > 1e-4 ||
  maxProtocolDelta === null || maxProtocolDelta < 0 || maxProtocolDelta > 1e-6 ||
  accuracy < minimumAccuracy ||
  f1 < minimumF1 ||
  falsePositiveRate > maximumFalsePositiveRate ||
  brier > maximumBrier ||
  benignWarnings > maximumBenignWarnings ||
  criticalMisses > maximumCriticalMisses ||
  averageLatency > maximumLatency ||
  fileSizeMb > maximumFileSizeMb ||
  report.passed_all_gates !== true ||
  !Array.isArray(report.gate_failures) ||
  report.gate_failures.length !== 0 ||
  report.model_sha256 !== modelHash ||
  report.runtime_acceptance_sha256 !== sha256(runtimeBytes) ||
  runtime.modelSha256 !== modelHash ||
  runtime.passed !== true ||
  !Array.isArray(runtime.failures) ||
  runtime.failures.length !== 0 ||
  !sameContract(report.input_contract) ||
  runtimeEvidence.modelSha256 !== modelHash ||
  runtimeEvidence.peakRssMb !== metadata.metrics.memoryBudgetMb ||
  summary.passedAllGates !== report.passed_all_gates ||
  summary.modelSha256 !== report.model_sha256 ||
  summary.corpusDigest !== report.corpus_digest ||
  summary.reportSha256 !== sha256(reportBytes) ||
  summary.inputContractIdentifier !== metadata.inputContract?.identifier ||
  summary.policyVersion !== report.policy_version ||
  summary.basis !== report.validation_basis ||
  summary.falsePositiveRate !== falsePositiveRate ||
  summary.benignWarningCount !== benignWarnings ||
  summary.criticalMissCount !== criticalMisses ||
  summary.independentTestGroups !== report.independent_test_groups ||
  metadata.metrics.accuracy !== accuracy ||
  metadata.metrics.f1Score !== f1 ||
  metadata.metrics.latencyMs !== report.latency_ms_average
) {
  fail('Model validation summary is not coherent with the hash-bound release report');
}

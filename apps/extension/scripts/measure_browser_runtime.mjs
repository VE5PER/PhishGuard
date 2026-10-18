import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir, platform, release, cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../node_modules/vite/dist/node/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../../..');
const candidate = resolve(root, 'apps/ml-lifecycle/checkpoints/context-recovery-20261011-r3/candidate');
const outputIndex = process.argv.indexOf('--output');
const output = process.argv[outputIndex + 1];
const headed = process.argv.includes('--headed');
if (outputIndex < 0 || !output) throw new Error('Required option --output');
if (existsSync(output)) throw new Error('Browser runtime evidence is immutable');
const modelBytes = readFileSync(resolve(candidate, 'student_model.onnx'));
const modelSha256 = createHash('sha256').update(modelBytes).digest('hex');
const reportBytes = readFileSync(resolve(candidate, 'evaluation-with-source.json'));
const report = JSON.parse(reportBytes);
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
if (modelSha256 !== '7b5d1fcb1d945c0c0e5101f264bd948ab31487a17df4a5f30690c63a2f4878c7'
    || reportSha256 !== '108010413752248bf5ea86b47e28e26a4a4e0976795f10452d21af2bbc0c4702') {
  throw new Error('The authoritative r3 model/report bytes changed');
}

const workspace = mkdtempSync(resolve(tmpdir(), 'phishguard-browser-runtime-'));
const extension = resolve(workspace, 'extension');
const profile = resolve(workspace, 'profile');
mkdirSync(extension);
mkdirSync(profile);
mkdirSync(resolve(extension, 'models'));
cpSync(resolve(root, 'apps/extension/public/assets'), resolve(extension, 'assets'), { recursive: true });
copyFileSync(resolve(candidate, 'student_model.onnx'), resolve(extension, 'models/student_model.onnx'));
copyFileSync(resolve(candidate, 'runtime-fixture.json'), resolve(extension, 'runtime-fixture.json'));
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/extension/manifest.json'), 'utf8'));
writeFileSync(resolve(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'PhishGuard Frozen Runtime Probe',
  version: manifest.version,
  permissions: ['storage', 'unlimitedStorage'],
  background: { service_worker: 'probe.js', type: 'module' },
  content_security_policy: manifest.content_security_policy,
}));
const runtime = JSON.parse(readFileSync(resolve(candidate, 'runtime-evidence.json'), 'utf8'));
writeFileSync(resolve(extension, 'models/student_model.metadata.json'), JSON.stringify({
  version: '0.0.0-candidate', name: 'unreleased-frozen-candidate-test', architecture: 'student-v2',
  sha256: modelSha256, fileSizeBytes: modelBytes.length, releasedAt: new Date().toISOString(),
  minExtensionVersion: manifest.version,
  features: ['x', 'y', 'dx', 'dy', 'v', 'theta', 'viewport_rgb_64', 'page_context_16'],
  metrics: {
    accuracy: report.metrics.accuracy, f1Score: report.metrics.f1,
    latencyMs: report.latency_ms_average, memoryBudgetMb: runtime.peakRssMb,
  },
  changelog: [], downloadUrl: 'candidate-local-only', inputContract: report.input_contract,
  validationSummary: {
    passedAllGates: report.passed_all_gates, modelSha256, corpusDigest: report.corpus_digest,
    reportSha256, inputContractIdentifier: 'student-v2', policyVersion: report.policy_version,
    basis: report.validation_basis, falsePositiveRate: report.metrics.false_positive_rate,
    benignWarningCount: report.metrics.benign_warning_count, criticalMissCount: report.metrics.critical_miss_count,
    independentTestGroups: report.independent_test_groups,
  },
}));
await build({
  root: resolve(root, 'apps/extension'), configFile: false, publicDir: false,
  resolve: { mainFields: ['main'] },
  build: {
    outDir: extension, emptyOutDir: false, minify: 'esbuild',
    rollupOptions: {
      input: resolve(scriptDir, 'runtime_probe_worker.ts'),
      output: { entryFileNames: 'probe.js', format: 'es' },
    },
  },
});

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else {
        this.events.push(message);
      }
    });
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
      this.pending.set(id, { resolve: resolveResult, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression, sessionId) {
    const response = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
}

function readMemory(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
  const hwm = Number(status.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(rss) || !Number.isFinite(hwm)) throw new Error('Worker process RSS is unavailable');
  return { rssMb: rss / 1024, hwmMb: hwm / 1024 };
}

const chrome = spawn('/usr/bin/google-chrome', [
  ...(!headed ? ['--headless=new'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const stderr = [];
chrome.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
let socket;
try {
  const activePort = resolve(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100 && !existsSync(activePort); attempt++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${stderr.join('')}`);
    await delay(100);
  }
  if (!existsSync(activePort)) throw new Error(`Chrome did not expose local CDP: ${stderr.join('')}`);
  const [port, endpoint] = readFileSync(activePort, 'utf8').trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(socket);
  const browser = await cdp.call('Browser.getVersion');
  await cdp.call('Extensions.loadUnpacked', { path: extension });
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await cdp.call('Target.getTargets');
    target = targetInfos.find((item) => item.type === 'service_worker' && item.url.endsWith('/probe.js'));
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error(`Isolated extension worker not found: ${stderr.join('')}`);
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.call('Runtime.enable', {}, sessionId);
  const marker = `phishguard-runtime-baseline-${Date.now()}`;
  await cdp.call('Tracing.start', { categories: 'blink.user_timing', transferMode: 'ReportEvents' });
  await cdp.evaluate(`performance.mark(${JSON.stringify(marker)})`, sessionId);
  await cdp.call('Tracing.end');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (cdp.events.some((event) => event.method === 'Tracing.tracingComplete')) break;
    await delay(100);
  }
  const pids = new Set(cdp.events
    .filter((event) => event.method === 'Tracing.dataCollected')
    .flatMap((event) => event.params.value)
    .filter((event) => event.name === marker)
    .map((event) => event.pid));
  if (pids.size !== 1) throw new Error('Cannot uniquely bind the worker target to its OS process');
  const workerPid = [...pids][0];
  const baseline = readMemory(workerPid);
  const initialization = await cdp.evaluate('phishguardRuntimeProbe.initialize()', sessionId);
  if (initialization.modelSha256 !== modelSha256) throw new Error('Browser activated another model');
  const measurements = await cdp.evaluate('phishguardRuntimeProbe.measure()', sessionId);
  const peak = readMemory(workerPid);
  const timings = measurements.timingsMs;
  if (timings.length !== 130 || timings.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Missing or invalid browser inference timings');
  }
  const sorted = [...timings].sort((left, right) => left - right);
  const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  const failures = [];
  const warnings = [];
  if (average > 40) failures.push('Browser inference average exceeds 40 ms');
  if (peak.hwmMb >= 512) failures.push('Isolated extension worker peak RSS reaches or exceeds 512 MiB hard ceiling');
  if (peak.hwmMb > 200) warnings.push(`Isolated extension worker peak RSS ${peak.hwmMb.toFixed(1)} MiB exceeds the 200 MiB soft target`);
  const evidence = {
    format: 'student-browser-runtime-v2', modelSha256, reportSha256,
    browser: browser.product, javascriptVersion: browser.jsVersion,
    headless: !headed,
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unavailable',
    runtime: 'Chrome MV3 service worker, production OnDeviceStudentEngine, WASM provider',
    scope: 'Frozen local constructed fixtures; inference includes preprocessing, graph, evidence policy and explainability; no screenshot capture or real-site traffic',
    memoryMethod: 'Linux /proc VmHWM of the unique service-worker renderer process identified through a CDP worker performance.mark tracing event; includes Chromium worker overhead',
    browserMemoryMeasured: true, workerPid, baselineRssMb: baseline.rssMb,
    baselinePeakRssMb: baseline.hwmMb, finalRssMb: peak.rssMb, peakRssMb: peak.hwmMb,
    peakAboveBaselineRssMb: Math.max(0, peak.hwmMb - baseline.rssMb),
    inferenceSamples: timings.length, iterationsPerCase: 10,
    latencyMsAverage: average, latencyMsP50: sorted[Math.floor(sorted.length * 0.50)],
    latencyMsP95: sorted[Math.floor(sorted.length * 0.95)], latencyMsMax: sorted.at(-1),
    maxCpuWebError: measurements.maxCpuWebError, cases: measurements.cases,
    softTargetMiB: 200,
    gates: { maxAverageLatencyMs: 40, maxWorkerPeakMemoryMiBExclusive: 512 },
    passed: failures.length === 0, failures, warnings, measuredAt: new Date().toISOString(), workspace,
  };
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(evidence));
  if (failures.length) process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  writeFileSync(resolve(workspace, 'chrome.stderr.log'), stderr.join(''));
}

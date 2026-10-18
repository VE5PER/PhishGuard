import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../node_modules/vite/dist/node/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../../..');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`Required option ${name}`);
  return value;
}
const modelPath = resolve(option('--model'));
const fixturePath = resolve(option('--fixture'));
const outputPath = resolve(option('--output'));
const runtime = option('--runtime', 'wasm');
const mode = option('--mode', 'graph');
const engineRoot = resolve(option('--engine-root', resolve(root, 'apps/extension')));
const metadataPath = mode === 'engine' ? resolve(option('--metadata')) : null;
if (!['wasm', 'jsep'].includes(runtime) || !['graph', 'engine'].includes(mode)) {
  throw new Error('Unsupported runtime/probe mode');
}
if (existsSync(outputPath)) throw new Error('Runtime measurement is immutable');
const modelBytes = readFileSync(modelPath);
const modelSha256 = createHash('sha256').update(modelBytes).digest('hex');
const fixtureBytes = readFileSync(fixturePath);
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const fixture = JSON.parse(fixtureBytes);
if (fixture.format !== 'student-cpu-frozen-feeds-v1' ||
  ![fixture.sourceModelSha256, fixture.candidateModelSha256].includes(modelSha256) ||
  fixture.cases.length < 1) throw new Error('Fixture/model mismatch');
const workspace = mkdtempSync(resolve(tmpdir(), 'phishguard-cpu-probe-'));
const extension = resolve(workspace, 'extension');
const profile = resolve(workspace, 'profile');
mkdirSync(extension);
mkdirSync(profile);
mkdirSync(resolve(profile, 'Default'));
writeFileSync(resolve(profile, 'Default', 'Preferences'), JSON.stringify({
  extensions: { ui: { developer_mode: true } },
}));
mkdirSync(resolve(extension, 'assets'));
mkdirSync(resolve(extension, 'models'));
copyFileSync(modelPath, resolve(extension, 'models/student_model.onnx'));
copyFileSync(fixturePath, resolve(extension, 'fixture.json'));
if (metadataPath) copyFileSync(metadataPath, resolve(extension, 'models/student_model.metadata.json'));
const wasmName = runtime === 'wasm'
  ? 'ort-wasm-simd-threaded.wasm' : 'ort-wasm-simd-threaded.jsep.wasm';
const wasmPath = resolve(root, 'apps/extension/node_modules/onnxruntime-web/dist', wasmName);
copyFileSync(wasmPath, resolve(extension, 'assets', wasmName));
writeFileSync(resolve(extension, 'probe-config.json'), JSON.stringify({ runtime, mode, modelSha256 }));
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/extension/manifest.json')));
writeFileSync(resolve(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'PhishGuard Isolated CPU Probe', version: manifest.version,
  permissions: ['storage', 'unlimitedStorage'],
  background: { service_worker: 'probe.js', type: 'module' },
  content_security_policy: manifest.content_security_policy,
}));
const ortEntry = resolve(root, 'apps/extension/node_modules/onnxruntime-web/dist',
  runtime === 'wasm' ? 'ort.wasm.bundle.min.mjs' : 'ort.bundle.min.mjs');
await build({
  root: resolve(root, 'apps/extension'), configFile: false, publicDir: false,
  resolve: {
    alias: [
      { find: /^onnxruntime-web$/, replacement: ortEntry },
      { find: '../src/background/onnx-engine.js', replacement: resolve(engineRoot, 'src/background/onnx-engine.ts') },
    ],
  },
  build: {
    outDir: extension, emptyOutDir: false, minify: 'esbuild',
    rollupOptions: {
      input: resolve(scriptDir, 'cpu_probe_worker.ts'),
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
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else this.events.push(message);
    });
  }
  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
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

function memory(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
  const peak = Number(status.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(rss) || !Number.isFinite(peak)) throw new Error('Worker memory unavailable');
  return { rssMiB: rss / 1024, peakMiB: peak / 1024 };
}

function timings(values) {
  if (!values.length) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid inference timing');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1', '--enable-unsafe-extension-debugging',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const stderr = [];
chrome.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
try {
  const activePort = resolve(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100 && !existsSync(activePort); attempt++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${stderr.join('')}`);
    await delay(100);
  }
  if (!existsSync(activePort)) throw new Error('Isolated Chrome did not expose CDP');
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
  if (!target) throw new Error('Isolated probe worker not found');
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.call('Runtime.enable', {}, sessionId);
  const marker = `phishguard-cpu-probe-${Date.now()}`;
  await cdp.call('Tracing.start', { categories: 'blink.user_timing', transferMode: 'ReportEvents' });
  await cdp.evaluate(`performance.mark(${JSON.stringify(marker)})`, sessionId);
  await cdp.call('Tracing.end');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (cdp.events.some((event) => event.method === 'Tracing.tracingComplete')) break;
    await delay(100);
  }
  const pids = new Set(cdp.events.filter((event) => event.method === 'Tracing.dataCollected')
    .flatMap((event) => event.params.value).filter((event) => event.name === marker).map((event) => event.pid));
  if (pids.size !== 1) throw new Error('Cannot uniquely identify worker process');
  const workerPid = [...pids][0];
  const baseline = memory(workerPid);
  const initialization = await cdp.evaluate('phishguardCpuProbe.initialize()', sessionId);
  const measurement = await cdp.evaluate('phishguardCpuProbe.measure()', sessionId);
  if (measurement.timingsMs.length !== 200) throw new Error('Incomplete graph benchmark');
  const afterMeasurement = memory(workerPid);
  const soak = await cdp.evaluate('phishguardCpuProbe.soak()', sessionId);
  const afterSoak = memory(workerPid);
  const graphLatency = timings(measurement.timingsMs);
  const failures = [];
  const warnings = [];
  if (graphLatency.averageMs >= 40) failures.push('average_graph_latency_budget');
  if (afterSoak.peakMiB >= 512) failures.push('worker_peak_memory_budget');
  if (afterSoak.peakMiB > 200) warnings.push(`Worker peak RSS ${afterSoak.peakMiB.toFixed(1)} MiB exceeds the 200 MiB soft target`);
  const report = {
    format: 'student-browser-cpu-probe-v1',
    modelSha256, fixtureSha256, runtime, mode,
    browser: browser.product, javascriptVersion: browser.jsVersion,
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unavailable',
    wasmBytes: readFileSync(wasmPath).length,
    engineRoot: mode === 'engine' ? engineRoot : null,
    scope: 'Isolated headless Chrome MV3 worker, frozen constructed feeds; no site capture, queue/storage or network latency',
    memoryMethod: 'Unique worker renderer PID bound by CDP performance.mark tracing; Linux /proc VmRSS/VmHWM, including Chromium overhead',
    browserMemoryMeasured: true, workerPid, baseline, initialization,
    graphLatency, productionPipelineLatency: timings(measurement.pipelineTimingsMs),
    afterMeasurement, afterSoak, soak,
    maxCpuWebError: measurement.maxCpuWebError,
    cases: measurement.cases, timingsMs: measurement.timingsMs,
    softTargetMiB: 200,
    gates: { maxAverageGraphLatencyMsExclusive: 40, maxWorkerPeakMemoryMiBExclusive: 512 },
    passed: failures.length === 0, failures, warnings, workspace,
    measuredAt: new Date().toISOString(),
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, timingsMs: undefined, cases: undefined }));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  if (!existsSync(outputPath)) {
    writeFileSync(outputPath, JSON.stringify({
      format: 'student-browser-cpu-probe-v1',
      modelSha256, fixtureSha256, runtime, mode,
      engineRoot: mode === 'engine' ? engineRoot : null,
      passed: false,
      failures: ['probe_initialization_or_execution'],
      error: error instanceof Error ? error.message : String(error),
      browserMemoryMeasured: false,
      workspace,
      measuredAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx' });
  }
  throw error;
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  writeFileSync(resolve(workspace, 'chrome.stderr.log'), stderr.join(''));
}

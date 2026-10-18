/**
 * On-Device Inference Engine for Browser Extension Service Worker.
 *
 * Responsibilities:
 * 1. Loads distilled student ONNX model in WebGPU / WASM context.
 * 2. Preprocesses variable-length pointer sequences into normalized (1, 128, 6) Float32Array.
 * 3. Evaluates calibrated client risk score in < 40 ms.
 * 4. Implements Tri-State Decision Routing.
 */

import * as ort from 'onnxruntime-web/wasm';
import type {
  InteractionTelemetryPayload,
  ClientInferenceResult,
  PointerEventPoint,
  ModelMetadata,
  ModelSource,
} from '@phishguard/types';
import { ModelMetadataSchema } from '@phishguard/types';
import { sqliteStorage } from './sqlite-storage.js';
import { modelStorage } from './model-storage.js';
import type { ModalityBreakdown, VisionUnavailableReason } from './types.js';
import { presentVisionRecovery } from './vision-recovery.js';
import { prepareTrajectory } from './trajectory-preprocessor.js';
import {
  authorizedBrandHost,
  BRAND_LABELS,
  PAGE_CONTEXT_FEATURES,
  preparePageContext,
  sanitizeDisplayedBrands,
} from './page-context.js';
import { composeRisk, evaluateEvidenceRisk } from './risk-policy.js';

export const BUNDLED_BASELINE_METADATA: ModelMetadata = {
  version: '1.5.0',
  name: 'phishguard-student-vision-v1.5',
  architecture: '1D-CNN + BiLSTM + 64×64 visual trunk',
  sha256: 'cac2762da37bfcfc93953369042e2cf7614cc64f6cfb2ddfffd47c8334c1757b',
  fileSizeBytes: 158158,
  releasedAt: '2026-10-11T13:00:00Z',
  minExtensionVersion: '0.1.0',
  features: ['x', 'y', 'dx', 'dy', 'v', 'theta', 'viewport_rgb_64'],
  metrics: {
    accuracy: 1.0,
    f1Score: 1.0,
    latencyMs: 0.48,
    memoryBudgetMb: 30.0,
  },
  changelog: [
    'Bundled student model v1.5.0 with multimodal visual and behavioral encoder',
  ],
  downloadUrl: '/v1/models/1.5.0/download',
};

let ortWasmConfigPromise: Promise<void> | null = null;

function parseVersion(version: string): number[] | null {
  const core = version.replace(/^v/, '').split(/[+-]/, 1)[0];
  if (!/^\d+(?:\.\d+){0,2}$/.test(core)) return null;
  return core.split('.').map((part) => Number.parseInt(part, 10));
}

function versionMeetsMinimum(installed: string, minimum: string): boolean {
  const currentParts = parseVersion(installed);
  const requiredParts = parseVersion(minimum);
  if (!currentParts || !requiredParts) return false;
  for (let index = 0; index < 3; index++) {
    const difference = (currentParts[index] ?? 0) - (requiredParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function compareModelVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return match
      ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? null }
      : null;
  };
  const first = parse(left);
  const second = parse(right);
  if (!first || !second) return left.localeCompare(right);
  for (let index = 0; index < 3; index++) {
    const difference = first.core[index] - second.core[index];
    if (difference !== 0) return difference;
  }
  if (first.prerelease === null || second.prerelease === null) {
    if (first.prerelease === second.prerelease) return 0;
    return first.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(first.prerelease.length, second.prerelease.length); index++) {
    const a = first.prerelease[index];
    const b = second.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an !== bn) return an ? -1 : 1;
    return a.localeCompare(b);
  }
  return 0;
}

/**
 * Configure the ONNX Runtime WASM environment once per worker lifetime.
 *
 * Manifest V3 service workers cannot execute dynamic `import()`, so ORT must
 * never resolve a `.mjs` worker/proxy module: `env.wasm.wasmPaths` is only
 * ever assigned the URL-object form `{ wasm: <plain .wasm URL> }` — never a
 * string prefix. The non-JSEP SIMD binary is fetched once from the packaged
 * extension asset and handed to ORT via `env.wasm.wasmBinary` — ORT initializes
 * wasm once (guarded internally) and Emscripten keeps its own reference, so no
 * second copy of the 14 MiB buffer is retained here. Setup is single-flight so
 * concurrent activations share one fetch; a failed fetch clears the memoized
 * promise so a later initialize() retries instead of memoizing failure.
 */
function configureOrtWasm(): Promise<void> {
  if (ortWasmConfigPromise) return ortWasmConfigPromise;
  const promise = (async () => {
    try {
      ort.env.wasm.numThreads = 1;

      if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;

      const candidatePaths = [
        'dist/assets/ort-wasm-simd-threaded.wasm',
        'assets/ort-wasm-simd-threaded.wasm',
      ];

      let wasmUrl: string | null = null;
      let wasmBinary: ArrayBuffer | null = null;
      for (const relPath of candidatePaths) {
        try {
          const candidateUrl = chrome.runtime.getURL(relPath);
          const resp = await fetch(candidateUrl);
          if (resp.ok) {
            wasmBinary = await resp.arrayBuffer();
            wasmUrl = candidateUrl;
            break;
          }
        } catch (e) {
          console.warn(`[PhishGuard] Pre-fetching ${relPath} failed:`, e);
        }
      }

      // URL-object form only — a string prefix or .mjs override pushes ORT onto
      // its dynamic-import() code path, which is forbidden in a service worker.
      if (wasmUrl) {
        ort.env.wasm.wasmPaths = { wasm: wasmUrl };
      }
      if (wasmBinary) {
        ort.env.wasm.wasmBinary = wasmBinary;
        return;
      }
      // No binary could be fetched — do not memoize the failure.
      ortWasmConfigPromise = null;
    } catch (err) {
      ortWasmConfigPromise = null;
      throw err;
    }
  })();
  ortWasmConfigPromise = promise;
  return promise;
}

export class OnDeviceStudentEngine {
  private session: ort.InferenceSession | null = null;
  private isLoaded: boolean = false;
  private modelUrl: string | null = null;
  private activeVersion: string = BUNDLED_BASELINE_METADATA.version;
  private activeMetadata: ModelMetadata | null = BUNDLED_BASELINE_METADATA;
  private activeSource: ModelSource = 'LOCAL_BUNDLED';
  private readonly sessionUseCounts = new Map<ort.InferenceSession, number>();
  private readonly retiredSessions = new Set<ort.InferenceSession>();

  constructor(modelPath?: string) {
    if (modelPath) {
      this.modelUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL(modelPath)
        : modelPath;
    }
  }

  public getActiveVersion(): string {
    return this.activeVersion;
  }

  public getActiveMetadata(): ModelMetadata | null {
    return this.activeMetadata;
  }

  public getActiveSource(): ModelSource {
    return this.activeSource;
  }

  public isReady(): boolean {
    return this.isLoaded && this.session !== null;
  }

  private retainSession(session: ort.InferenceSession): void {
    this.sessionUseCounts.set(session, (this.sessionUseCounts.get(session) ?? 0) + 1);
  }

  private releaseSession(session: ort.InferenceSession): void {
    const remaining = (this.sessionUseCounts.get(session) ?? 1) - 1;
    if (remaining > 0) {
      this.sessionUseCounts.set(session, remaining);
      return;
    }
    this.sessionUseCounts.delete(session);
    if (this.retiredSessions.delete(session)) {
      session.release().catch(() => {});
    }
  }

  private retireSession(session: ort.InferenceSession | null): void {
    if (!session) return;
    if (this.sessionUseCounts.get(session)) {
      this.retiredSessions.add(session);
    } else {
      session.release().catch(() => {});
    }
  }

  private async createSession(buffer: ArrayBuffer): Promise<ort.InferenceSession> {
    return ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  private validateSessionSignature(
    session: ort.InferenceSession,
    metadata: ModelMetadata
  ): boolean {
    const names = [...session.inputNames];
    const sortedNames = [...names].sort();
    const v2Names = ['page_context', 'trajectory', 'visual'];
    const canonicalInputShapes: Record<string, number[]> = {
      trajectory: [128, 6],
      visual: [3, 64, 64],
      page_context: [16],
    };
    const isV2 = names.includes('page_context');
    const contract = metadata.inputContract ?? null;
    const validation = metadata.validationSummary ?? null;
    const expectedContract = isV2 ? 'student-v2' : 'student-v1';
    if (contract && contract.identifier !== expectedContract) return false;
    if (isV2 && (
      sortedNames.length !== v2Names.length ||
      v2Names.some((name, index) => sortedNames[index] !== name) ||
      !contract ||
      contract.trajectoryPreprocessing !== 'normalized-coordinate-derivatives-index-linear-v2' ||
      contract.contextFeatures.join('\0') !== PAGE_CONTEXT_FEATURES.join('\0') ||
      !validation ||
      !validation.passedAllGates ||
      validation.modelSha256.toLowerCase() !== metadata.sha256.toLowerCase() ||
      validation.inputContractIdentifier !== contract.identifier ||
      validation.policyVersion !== 'evidence-v2' ||
      validation.falsePositiveRate > 0.005 ||
      validation.benignWarningCount !== 0 ||
      validation.criticalMissCount !== 0
    )) {
      return false;
    }
    if (!isV2 && (
      names.length === 0 ||
      !names.includes('trajectory') ||
      names.some((name) => name !== 'trajectory' && name !== 'visual')
    )) {
      return false;
    }

    if (contract) {
      const contractNames = contract.inputs.map((input) => input.name).sort();
      if (contractNames.join('\0') !== sortedNames.join('\0')) return false;
    }
    const inputMetadata = new Map(session.inputMetadata.map((input) => [input.name, input]));
    for (const inputName of names) {
      const input = inputMetadata.get(inputName);
      const contractInput = contract?.inputs.find((candidate) => candidate.name === inputName);
      const expectedShape = canonicalInputShapes[inputName] ?? [];
      if (
        !input ||
        !input.isTensor ||
        input.type !== 'float32' ||
        input.shape.length !== expectedShape.length + 1 ||
        (typeof input.shape[0] === 'number' && input.shape[0] !== 1) ||
        input.shape.slice(1).some((dimension, index) => dimension !== expectedShape[index]) ||
        (contractInput && (
          contractInput.dtype !== 'float32' ||
          contractInput.shape.join(',') !== expectedShape.join(',')
        ))
      ) {
        return false;
      }
    }
    const output = session.outputMetadata.find((candidate) => candidate.name === 'risk_score');
    return !!output &&
      output.isTensor &&
      output.type === 'float32' &&
      output.shape.length === 2 &&
      (typeof output.shape[0] === 'string' || output.shape[0] === 1) &&
      output.shape[1] === 1;
  }

  /**
   * Serializes every ONNX graph execution — warmup and inference alike — so
   * only one `session.run` executes at a time across all tabs. The chain
   * swallows task failures, keeping the gate recoverable.
   */
  private graphExecutionQueue: Promise<void> = Promise.resolve();

  private runGraphExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.graphExecutionQueue.then(task);
    this.graphExecutionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private disposeTensors(tensors: Record<string, ort.Tensor> | undefined): void {
    if (!tensors) return;
    for (const tensor of Object.values(tensors)) {
      try {
        tensor?.dispose?.();
      } catch {
        /* disposal is best-effort */
      }
    }
  }

  private async warmSession(session: ort.InferenceSession): Promise<void> {
    const inputs: Record<string, ort.Tensor> = {
      trajectory: new ort.Tensor('float32', new Float32Array(128 * 6), [1, 128, 6]),
    };
    if (session.inputNames.includes('visual')) {
      inputs.visual = new ort.Tensor('float32', new Float32Array(3 * 64 * 64), [1, 3, 64, 64]);
    }
    if (session.inputNames.includes('page_context')) {
      inputs.page_context = new ort.Tensor('float32', new Float32Array(16), [1, 16]);
    }
    let results: ort.InferenceSession.OnnxValueMapType | undefined;
    try {
      results = await this.runGraphExclusive(() => session.run(inputs));
      const output = results.risk_score || Object.values(results)[0];
      const value = output?.data?.length ? Number(output.data[0]) : Number.NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('Model warmup output is invalid');
      }
    } finally {
      this.disposeTensors(results);
      this.disposeTensors(inputs);
    }
  }

  public async initialize(): Promise<void> {
    try {
      await configureOrtWasm();
      // Lazy candidates: enumerate version keys only, then fetch at most one
      // model binary at a time until an activation succeeds.
      const candidates: Array<{
        version: string;
        source: ModelSource;
        load: () => Promise<{ buffer: ArrayBuffer; metadata: ModelMetadata } | null>;
      }> = [];

      // 1. Check if an explicit model path was provided (e.g. for testing)
      if (this.modelUrl) {
        try {
          const modelUrl = this.modelUrl;
          const metadata = await this.loadMetadataSidecar(modelUrl);
          if (metadata) {
            candidates.push({
              version: metadata.version,
              source: 'LOCAL_BUNDLED',
              load: async () => {
                try {
                  const response = await fetch(modelUrl);
                  if (!response.ok) return null;
                  return { buffer: await response.arrayBuffer(), metadata };
                } catch {
                  return null;
                }
              },
            });
          }
        } catch {
          // Model file not found, proceed to client storage check
        }
      }

      // 2. Check if a model was previously synced and saved into client SQLite or IndexedDB storage
      try {
        const storedVersions = await sqliteStorage.listStoredModelVersions();
        for (const version of storedVersions) {
          candidates.push({
            version,
            source: 'CACHE_STORAGE',
            load: async () => {
              const stored = await sqliteStorage.getModel(version);
              return stored ? { buffer: stored.buffer, metadata: stored.metadata } : null;
            },
          });
        }
      } catch {}
      try {
        const storedVersions = await modelStorage.listStoredVersionKeys();
        for (const version of storedVersions) {
          candidates.push({
            version,
            source: 'CACHE_STORAGE',
            load: async () => {
              const stored = await modelStorage.getModel(version);
              return stored ? { buffer: stored.buffer, metadata: stored.metadata } : null;
            },
          });
        }
      } catch {}

      // 3. Fallback to bundled student model binary shipped with extension
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        const bundledCandidates = [
          'dist/models/student_model.onnx',
          'models/student_model.onnx',
        ];
        for (const relPath of bundledCandidates) {
          try {
            const bundledUrl = chrome.runtime.getURL(relPath);
            const metadata = await this.loadMetadataSidecar(bundledUrl);
            if (!metadata) continue;
            candidates.push({
              version: metadata.version,
              source: 'LOCAL_BUNDLED',
              load: async () => {
                try {
                  const response = await fetch(bundledUrl);
                  if (!response.ok) return null;
                  return { buffer: await response.arrayBuffer(), metadata };
                } catch (bundleErr) {
                  console.warn(`[PhishGuard] Bundled model loading from ${relPath} fallback note:`, bundleErr);
                  return null;
                }
              },
            });
          } catch (bundleErr) {
            console.warn(`[PhishGuard] Bundled model loading from ${relPath} fallback note:`, bundleErr);
          }
        }
      }

      candidates.sort((first, second) => compareModelVersions(second.version, first.version));
      for (const candidate of candidates) {
        let loaded: { buffer: ArrayBuffer; metadata: ModelMetadata } | null = null;
        try {
          loaded = await candidate.load();
        } catch {
          loaded = null;
        }
        if (loaded && await this.hotSwapModel(loaded.buffer, loaded.metadata, candidate.source)) {
          return;
        }
      }

      // 4. Lean fallback state
      this.session = null;
      this.isLoaded = false;
      this.activeVersion = '0.0.0';
      this.activeMetadata = null;
      this.activeSource = 'REMOTE_SYNCED';
      console.log('[PhishGuard] Extension running lean (no bundled model). Ready for remote model sync.');
    } catch (err) {
      console.warn('[PhishGuard] Initialization note:', err);
    }
  }

  private async loadMetadataSidecar(modelUrl: string): Promise<ModelMetadata | null> {
    const metadataUrl = modelUrl.replace(/student_model\.onnx(?=([?#]|$))/, 'student_model.metadata.json');
    try {
      const response = await fetch(metadataUrl);
      if (response.status === 404) return BUNDLED_BASELINE_METADATA;
      if (!response.ok) return null;
      const parsed = ModelMetadataSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return BUNDLED_BASELINE_METADATA;
    }
  }

  /**
   * Serializes model activation so only one session construction + warmup +
   * swap runs at a time. Later callers queue behind the in-flight activation
   * in request order; a failed activation never blocks queued callers.
   */
  private activationQueue: Promise<void> = Promise.resolve();

  public hotSwapModel(
    buffer: ArrayBuffer,
    metadata: ModelMetadata,
    source: ModelSource = 'REMOTE_SYNCED'
  ): Promise<boolean> {
    const activated = this.activationQueue.then(() =>
      this.activateModel(buffer, metadata, source)
    );
    this.activationQueue = activated.then(() => undefined, () => undefined);
    return activated;
  }

  /**
   * Hot-swaps the active ONNX inference session with a newly synchronized model binary.
   */
  private async activateModel(
    buffer: ArrayBuffer,
    metadata: ModelMetadata,
    source: ModelSource = 'REMOTE_SYNCED'
  ): Promise<boolean> {
    let newSession: ort.InferenceSession | null = null;
    try {
      const parsedMetadata = ModelMetadataSchema.safeParse(metadata);
      if (
        !parsedMetadata.success ||
        parsedMetadata.data.version !== metadata.version ||
        parsedMetadata.data.fileSizeBytes !== buffer.byteLength
      ) {
        return false;
      }
      if (
        this.isReady() &&
        this.activeMetadata &&
        parsedMetadata.data.version === this.activeVersion &&
        parsedMetadata.data.sha256.toLowerCase() === this.activeMetadata.sha256.toLowerCase()
      ) {
        // Identical version + hash is already active; skip session construction.
        return true;
      }
      if (this.isReady() && compareModelVersions(parsedMetadata.data.version, this.activeVersion) < 0) {
        return false;
      }
      if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
        const installedVersion = chrome.runtime.getManifest().version;
        if (!versionMeetsMinimum(installedVersion, parsedMetadata.data.minExtensionVersion)) return false;
      }
      const computedHash = await crypto.subtle.digest('SHA-256', buffer.slice(0));
      const actualHash = Array.from(new Uint8Array(computedHash))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (actualHash.toLowerCase() !== parsedMetadata.data.sha256.toLowerCase()) return false;
      await configureOrtWasm();
      newSession = await this.createSession(buffer.slice(0));
      if (!this.validateSessionSignature(newSession, parsedMetadata.data)) {
        await newSession.release();
        return false;
      }
      await this.warmSession(newSession);

      if (this.isReady() && compareModelVersions(parsedMetadata.data.version, this.activeVersion) < 0) {
        const staleSession = newSession;
        newSession = null;
        await staleSession.release().catch(() => {});
        return false;
      }

      const previousSession = this.session;
      // Atomically swap the active session
      this.session = newSession;
      this.activeVersion = parsedMetadata.data.version;
      this.activeMetadata = parsedMetadata.data;
      this.activeSource = source;
      this.isLoaded = true;
      newSession = null;
      this.retireSession(previousSession);

      console.log(`[PhishGuard] Successfully hot-swapped to student model v${parsedMetadata.data.version} (${source})`);
      return true;
    } catch (err) {
      await newSession?.release().catch(() => {});
      console.error('[PhishGuard] Model activation failed validation or warmup:', err instanceof Error ? err.name : 'Error');
      return false;
    }
  }


  /**
   * Resamples raw pointer points into fixed (128, 6) Float32Array matching PyTorch TrajectoryDataset.
   */
  public preprocessTrajectory(points: PointerEventPoint[]): Float32Array {
    return prepareTrajectory(points).tensor;
  }

  /**
   * Evaluates telemetry payload and produces calibrated client risk score.
   */
  public async predict(payload: InteractionTelemetryPayload): Promise<ClientInferenceResult> {
    return (await this.predictDetailed(payload)).result;
  }

  /**
   * Evaluates telemetry payload and also reports the per-modality breakdown behind the fused score.
   */
  public async predictDetailed(
    payload: InteractionTelemetryPayload,
    visual?: Float32Array | null,
    runtimeAvailability?: {
      topologyScanComplete?: boolean;
      visionUnavailableReason?: VisionUnavailableReason | null;
      visionRecoveryAttempt?: number;
      displayedBrands?: string[];
    }
  ): Promise<{ result: ClientInferenceResult; breakdown: ModalityBreakdown }> {
    const startTime = performance.now();
    const session = this.session;
    const sessionLoaded = this.isLoaded;
    const activeVersion = this.activeVersion;
    const activeMetadata = this.activeMetadata;
    const prepared = prepareTrajectory(payload.pointerSeries);
    const visualAvailable = visual instanceof Float32Array &&
      visual.length === 3 * 64 * 64 &&
      visual.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
    const visualTensor = visualAvailable ? visual! : null;
    const page = preparePageContext(payload, prepared, visualAvailable);
    const evidence = evaluateEvidenceRisk(page);
    const inputNames = session?.inputNames ?? [];
    const isV2 = inputNames.includes('page_context');
    const topologyScanComplete = runtimeAvailability?.topologyScanComplete ?? true;
    const displayedBrands = sanitizeDisplayedBrands(runtimeAvailability?.displayedBrands);
    const brandLogoMismatch = page.available
      ? displayedBrands.filter((brand) => !authorizedBrandHost(page.hostname, brand))
      : [];
    const brandLogoReason = brandLogoMismatch.length > 0
      ? `Displayed ${brandLogoMismatch.map((brand) => BRAND_LABELS[brand] ?? brand).join(' / ')} logo is not authorized for ${page.hostname}`
      : null;
    const modelContract: ModalityBreakdown['fused']['modelContract'] =
      session ? isV2 ? 'student-v2' : 'legacy' : 'none';
    let modelScore: number | null = null;

    if (session && sessionLoaded) {
      const legacyHasVisual = inputNames.includes('visual');
      if ((isV2 && page.available) || (!isV2 && prepared.available && (!legacyHasVisual || visualAvailable))) {
        try {
          const trajectoryData = prepared.available ? prepared.tensor : new Float32Array(128 * 6);
          this.retainSession(session);
          try {
            const modelOutput = await this.runSession(session, trajectoryData, visualTensor, page.context, isV2);
            if (Number.isFinite(modelOutput) && modelOutput >= 0 && modelOutput <= 1) {
              modelScore = modelOutput;
            }
          } finally {
            this.releaseSession(session);
          }
        } catch (e) {
          console.error('[PhishGuard] ONNX session run error:', e);
        }
      }
    }

    // Calibrate with DOM suspicious interactions
    // Evaluate full URL anomalies & deceptive targeting
    const fused = composeRisk(modelScore, evidence.score);
    const reasons = [...evidence.reasons];
    if (modelScore !== null && modelScore > evidence.score && modelScore > 0.85) {
      reasons.push('On-device multimodal model detected high risk');
    }
    const totalAnomalies = page.credentialTraps + page.submitTraps + page.otherTraps +
      Number(page.observedCredentialFrame) +
      Number(evidence.ruleIds.some((ruleId) =>
        ruleId === 'deceptive_authority' || ruleId === 'deceptive_brand_login_host'
      ));
    const pageDetail = evidence.reasons.length > 0
      ? `${evidence.reasons.join(' · ')}${topologyScanComplete ? '' : ' · Topology scan incomplete'}`
      : !page.available ? 'Page context unavailable'
        : topologyScanComplete ? 'No verified page evidence' : 'Topology scan incomplete; page evidence is partial';
    const latencyMs = Math.round(performance.now() - startTime);
    const samples = payload.pointerSeries.length;
    // Multimodal correlation: correlate visual representation against findings of Page & Interaction models
    // Visual appearance alone is below threshold (< 0.15), but correlates with anomalies found in DOM
    // Proactively scan visual layout when frame was captured even if on-device model has no vision input
    const visionDetail = !visualAvailable
      ? presentVisionRecovery(
        runtimeAvailability?.visionUnavailableReason,
        false,
        runtimeAvailability?.visionRecoveryAttempt ?? 0
      ).detail
      : modelScore === null
        ? session && sessionLoaded && !isV2 && !prepared.available
          ? 'Visual frame captured; waiting for enough pointer movement to run the model'
          : 'Visual frame captured; model inference unavailable'
        : isV2 || inputNames.includes('visual')
          ? 'Visual input included in fused model evaluation'
          : 'Visual frame captured; model contract does not consume this modality';

    // Tri-State Routing Logic
    const breakdown: ModalityBreakdown = {
      interaction: {
        score: null,
        status: prepared.available ? 'ok' : 'skipped',
        detail: prepared.available
          ? `Behavioral coverage ${prepared.validPointCount}/128 points · ${Math.round(prepared.durationMs)} ms`
          : `Behavioral input unavailable · ${prepared.invalidReason ?? 'insufficient coverage'}`,
        samples,
        explainability: {
          available: prepared.available,
          validPointCount: prepared.validPointCount,
          durationMs: prepared.durationMs,
          invalidReason: prepared.invalidReason,
        },
      },
      page: {
        score: evidence.score,
        status: !page.available || (!topologyScanComplete && evidence.ruleIds.length === 0)
          ? 'skipped'
          : evidence.ruleIds.length > 0 ? 'flag' : 'ok',
        detail: pageDetail,
        anomalies: totalAnomalies,
        explainability: {
          ruleIds: evidence.ruleIds,
          reasons: evidence.reasons,
        },
      },
      vision: {
        score: null,
        status: brandLogoMismatch.length > 0 ? 'flag' : visualAvailable ? 'ok' : 'skipped',
        detail: visionDetail,
        explainability: {
          available: visualAvailable,
          captureReason: visualAvailable ? null : runtimeAvailability?.visionUnavailableReason ?? null,
          captureState: presentVisionRecovery(
            runtimeAvailability?.visionUnavailableReason,
            visualAvailable,
            runtimeAvailability?.visionRecoveryAttempt ?? 0
          ).captureState,
          brandLogoMismatch,
          brandLogoReason,
        },
      },
      fused: {
        score: fused.score,
        modelScore,
        evidenceScore: evidence.score,
        modelStatus: modelScore === null ? 'unavailable' : 'available',
        modelContract: modelScore === null && !isV2 ? 'none' : modelContract,
        modelVersion: modelScore !== null ? activeMetadata?.version ?? null : null,
        modelHash: modelScore !== null ? activeMetadata?.sha256 ?? null : null,
        inputContractIdentifier: modelScore === null
          ? null
          : activeMetadata?.inputContract?.identifier ?? (isV2 ? 'student-v2' : 'student-v1'),
        reasons,
        ruleIds: evidence.ruleIds,
        coverage: {
          trajectoryAvailable: prepared.available,
          validPointCount: prepared.validPointCount,
          durationMs: prepared.durationMs,
          visualAvailable,
          pageContextAvailable: page.available,
          topologyScanComplete,
        },
      },
    };

    return {
      result: {
        clientRiskScore: fused.score,
        routeAction: fused.action,
        inferenceLatencyMs: latencyMs,
        evaluatedAt: new Date().toISOString(),
        modelVersion: modelScore === null
          ? 'unavailable'
          : activeMetadata ? `v${activeVersion}` : 'unversioned-session',
      },
      breakdown,
    };
  }

  private async runSession(
    session: ort.InferenceSession,
    trajectoryData: Float32Array,
    visual: Float32Array | null,
    pageContext: Float32Array,
    isV2: boolean
  ): Promise<number> {
    const inputNames = session.inputNames ?? [];
    const expectedV2 = ['page_context', 'trajectory', 'visual'];
    const sortedInputNames = [...inputNames].sort();
    if (isV2 && (sortedInputNames.length !== expectedV2.length ||
      expectedV2.some((name, index) => sortedInputNames[index] !== name))) {
      throw new Error('student-v2 ONNX input signature is unsupported');
    }
    if (!isV2 && (!inputNames.includes('trajectory') ||
      inputNames.some((name) => name !== 'trajectory' && name !== 'visual'))) {
      throw new Error('Legacy ONNX input signature is unsupported');
    }
    const feeds: Record<string, ort.Tensor> = {
      trajectory: new ort.Tensor('float32', trajectoryData, [1, 128, 6]),
    };
    if (isV2 || inputNames.includes('visual')) {
      feeds.visual = new ort.Tensor('float32', visual ?? new Float32Array(3 * 64 * 64), [1, 3, 64, 64]);
    }
    if (isV2) {
      feeds.page_context = new ort.Tensor('float32', pageContext, [1, 16]);
    }
    let results: ort.InferenceSession.OnnxValueMapType | undefined;
    try {
      results = await this.runGraphExclusive(() => session.run(feeds));
      const outputName = session.outputNames && session.outputNames.length > 0
        ? session.outputNames[0]
        : 'risk_score';
      const output = results[outputName] || results.risk_score || Object.values(results)[0];
      if (!output || !output.data || output.data.length < 1) throw new Error('ONNX session returned no output');
      return Number(output.data[0]);
    } finally {
      this.disposeTensors(results);
      this.disposeTensors(feeds);
    }
  }

  /**
   * Fast kinematic feature heuristics fallback when WASM is initializing.
   */
  // High jitter + very low velocity or sudden hesitations near inputs indicate suspicious interaction
}

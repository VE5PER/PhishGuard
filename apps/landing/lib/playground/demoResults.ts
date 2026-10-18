import type { CloudInferenceVerdict, PlaygroundRunResponse, PlaygroundScenario, TeacherToolCall } from "@phishguard/types";
import edgeFixtures from "./demo/edge.json";
import evidenceFixtures from "./demo/evidence.json";
import geminiFixtures from "./demo/gemini-illustrative.json";

export type EdgeRoute = "SAFE" | "AMBIGUOUS" | "BLOCK";

export interface EdgeResult {
  modelScore: number | null;
  evidenceScore: number;
  fusedScore: number;
  route: EdgeRoute;
  ruleIds: string[];
  reasons: string[];
  latencyMs: number | null;
  modelVersion: string | null;
  modelSha256: string | null;
  inputContract: string | null;
  modelStatus: "available" | "unavailable";
  unavailableReason: string | null;
}

type GeminiScenarioFixture = {
  latencyMs: number;
  toolCalls: TeacherToolCall[];
  verdict: {
    fromEvidenceBaseline?: boolean;
    extraReasons?: string[];
    isPhishing?: boolean;
    targetBrand?: string | null;
    confidence?: number;
    actionOverride?: "ALLOW" | "WARN" | "BLOCK";
    riskScore?: number;
    explanationReasons?: string[];
    screenAnalysis: NonNullable<CloudInferenceVerdict["screenAnalysis"]>;
  };
};

type EvidenceFixture = { latencyMs: number; verdict: CloudInferenceVerdict };

const edgeById = edgeFixtures as unknown as Record<string, EdgeResult>;
const evidenceById = evidenceFixtures as unknown as Record<string, EvidenceFixture>;
const geminiById = geminiFixtures.scenarios as unknown as Record<string, GeminiScenarioFixture>;

function freshIds(telemetryId: string) {
  return {
    analysisId: globalThis.crypto.randomUUID(),
    telemetryId,
    evaluatedAt: new Date().toISOString(),
  };
}

function buildGeminiVerdict(
  fixture: GeminiScenarioFixture,
  evidence: CloudInferenceVerdict,
  telemetryId: string,
): CloudInferenceVerdict {
  const given = fixture.verdict;
  const ids = freshIds(telemetryId);
  const teacherModelVersion = geminiFixtures.teacherModelVersion;
  if (given.fromEvidenceBaseline) {
    const evidenceRisk = evidence.riskScore ?? undefined;
    return {
      ...ids,
      isPhishing: false,
      targetBrand: evidence.targetBrand ?? null,
      confidence: evidence.confidence,
      actionOverride: evidence.actionOverride,
      explanationReasons: [...evidence.explanationReasons, ...(given.extraReasons ?? [])],
      teacherModelVersion,
      riskScore: evidence.riskScore ?? null,
      screenAnalysis: {
        ...given.screenAnalysis,
        screenRiskScore: Math.min(given.screenAnalysis.screenRiskScore, evidenceRisk ?? given.screenAnalysis.screenRiskScore),
      },
    };
  }
  return {
    ...ids,
    isPhishing: given.isPhishing as boolean,
    targetBrand: given.targetBrand ?? null,
    confidence: given.confidence as number,
    actionOverride: given.actionOverride as "ALLOW" | "WARN" | "BLOCK",
    explanationReasons: given.explanationReasons as string[],
    teacherModelVersion,
    riskScore: given.riskScore ?? null,
    screenAnalysis: given.screenAnalysis,
  };
}

export function getDemoRun(scenario: PlaygroundScenario): { edge: EdgeResult; run: PlaygroundRunResponse } {
  const edge = edgeById[scenario.id];
  const recordedEvidence = evidenceById[scenario.id];
  const gemini = geminiById[scenario.id];
  if (!edge || !recordedEvidence || !gemini) throw new Error(`No demo results for scenario ${scenario.id}`);

  const telemetryId = globalThis.crypto.randomUUID();
  const payload = {
    ...scenario.payload,
    telemetryId,
    clientTimestamp: new Date().toISOString(),
    clientRiskScore: edge.fusedScore,
    clientModelVersion: edge.modelVersion,
    clientModelSha256: edge.modelSha256,
    clientInputContract: edge.inputContract,
  };
  const evidenceVerdict: CloudInferenceVerdict = { ...recordedEvidence.verdict, ...freshIds(telemetryId) };
  const geminiVerdict = buildGeminiVerdict(gemini, evidenceVerdict, telemetryId);

  return {
    edge,
    run: {
      payload,
      evidence: { verdict: evidenceVerdict, latencyMs: recordedEvidence.latencyMs, cached: false },
      gemini: {
        verdict: geminiVerdict,
        latencyMs: gemini.latencyMs,
        cached: false,
        trace: {
          status: "ok",
          model: geminiFixtures.model,
          toolCalls: gemini.toolCalls,
          latencyMs: gemini.latencyMs,
          cached: false,
          fallbackReason: null,
        },
      },
    },
  };
}

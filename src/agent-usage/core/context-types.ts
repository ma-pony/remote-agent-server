import type { UsageBinding, UsageFilter } from "./types.js";

export const capabilityKinds = ["mcp_tool", "builtin_tool", "cli", "skill", "plugin", "hook", "unknown"] as const;
export type CapabilityKind = typeof capabilityKinds[number];
export type RankingDimension = CapabilityKind;
export type AttributionEvidence = "direct" | "matched" | "inferred";
export type ContextCoverage = "full" | "partial" | "opaque" | "none";

export type Capability = {
  id: string;
  kind: CapabilityKind;
  name: string;
  serverId?: string;
  version?: string;
};

export type CapabilityReference = {
  capability: Capability;
  evidence: AttributionEvidence;
};

export type ContextContent =
  | { identity: string; modality: "text"; text: string }
  | { identity: string; modality: "unsupported"; mediaType?: string; byteLength?: number };

export type ContextBlock = {
  position: number;
  kind: "definition" | "arguments" | "result" | "skill" | "other";
  toolInvocationId?: string;
  content: ContextContent;
  capabilities: CapabilityReference[];
};

export type ModelContextInput = {
  invocationId: string;
  providerEpochId: string;
  sourceId: string;
  revision: number;
  occurredAt: string | null;
  runtimeKind: string | null;
  model: string | null;
  modelProvider?: string | null;
  coverage: ContextCoverage;
  historyComplete: boolean;
  blocks: ContextBlock[];
};

export type InvocationStatus = "running" | "succeeded" | "tool_error" | "transport_error" | "cancelled";
export type ExecutionEvidence = "direct" | "inferred" | "unknown";
export type InvocationOrigin = "execution" | "context";
export type InvocationQueryOrigin = "counted" | InvocationOrigin;
export type InvocationInput = {
  invocationId: string;
  providerEpochId: string;
  executionId: string | null;
  capability: Capability;
  startedAt: string | null;
  endedAt: string | null;
  status: InvocationStatus;
  runtimeKind?: string | null;
  executionEvidence?: ExecutionEvidence;
  origin?: InvocationOrigin;
  sourceId: string;
  revision: number;
  rawResultBytes: number | null;
};

export type TokenEstimate = {
  measurement: "estimated";
  method: "model_tokenizer" | "text_heuristic" | "legacy_reference" | "unavailable";
  heuristicVersion?: "unicode-weighted-v1";
  model: string | null;
  modelProvider: string | null;
  tokenizer: string | null;
  tokenizerVersion: string | null;
  tokenizerId: string | null;
  tokenizerRevision: string | null;
  encoding: string | null;
  reason: "model_missing" | "model_unmapped" | "unsupported_content" | "size_limit" | "tokenization_failed" | "legacy_unavailable" | null;
};

export type TokenEstimateSummary = TokenEstimate & {
  exposureCount: number;
  knownExposureCount: number;
  totalInputTokens: number | null;
};

export type CoverageCounts = Record<ContextCoverage, number>;

export type AttributionRankRow = {
  measurement: "estimated";
  tokenizationStatus: "unavailable" | "single" | "mixed";
  tokenEstimates: TokenEstimateSummary[];
  inputBytes: number | null;
  capability: Capability;
  calls: number;
  contextOnlyCalls: number;
  successes: number;
  failures: number;
  unfinished: number;
  definitionInputTokens: number | null;
  argumentInputTokens: number | null;
  firstResultInputTokens: number | null;
  repeatedResultInputTokens: number | null;
  unknownFirstResultInputTokens: number | null;
  totalInputTokens: number | null;
  exposureCount: number;
  missingExposureCount: number;
  estimateCompleteness: "none" | "partial" | "complete";
  attributionEvidence: Record<AttributionEvidence, number>;
  contextCoverage: CoverageCounts;
  rawResultBytes: number | null;
  rawResultBytesP50: number | null;
  rawResultBytesP95: number | null;
  rawResultBytesSampleCount: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  latencySampleCount: number;
};

export type AttributionInvocation = UsageBinding & {
  id: string;
  invocationId: string;
  providerEpochId: string;
  executionId: string | null;
  capability: Capability;
  startedAt: string | null;
  endedAt: string | null;
  status: InvocationStatus;
  runtimeKind: string | null;
  executionEvidence: ExecutionEvidence;
  origin: InvocationOrigin;
  sourceId: string;
  revision: number;
  rawResultBytes: number | null;
};

export type ResultFirstUse = "first" | "repeat" | "unknown";
export type AttributionExposure = TokenEstimate & {
  modelInvocationId: string;
  providerEpochId: string;
  occurredAt: string | null;
  position: number;
  kind: ContextBlock["kind"];
  evidence: AttributionEvidence;
  coverage: ContextCoverage;
  contentIdentityHash: string;
  modality: ContextContent["modality"];
  byteLength: number | null;
  tokens: number | null;
  resultFirstUse: ResultFirstUse | null;
};

export type AttributionDetail = {
  invocation: AttributionInvocation;
  exposures: AttributionExposure[];
  subsequentModelInvocationIds: string[];
};

export type AttributionFilter = UsageFilter;

/** A capability's observed input in one model request, independent of tool execution. */
export type ContextEvidence = {
  id: string;
  namespace: string;
  agentId: string;
  sessionId: string;
  providerEpochId: string;
  modelInvocationId: string;
  occurredAt: string | null;
  runtimeKind: string | null;
  model: string | null;
  capability: Capability;
  exposureCount: number;
};
export type ContextEvidenceDetail = {
  context: ContextEvidence;
  exposures: Array<AttributionExposure & { toolInvocationId: string | null }>;
};

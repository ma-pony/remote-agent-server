import type { UsageBinding, UsageFilter } from "./types.js";

export const capabilityKinds = ["mcp_tool", "builtin_tool", "cli", "skill", "plugin", "hook", "user_prompt", "configured_instructions", "system_prompt", "assistant_output", "assistant_thought", "unknown"] as const;
export type CapabilityKind = typeof capabilityKinds[number];
export type RankingDimension = CapabilityKind | "all";
export type AttributionEvidence = "direct" | "matched" | "inferred";
export type ContextCoverage = "full" | "partial" | "opaque" | "none";

export type Capability = {
  id: string;
  kind: CapabilityKind;
  name: string;
  serverId?: string;
  version?: string;
};

/** Stable content identities join once-observed Runtime text with captured model-input exposures. */
export const contentCapability = (category: string): Capability | undefined => {
  if (category === "configured_instructions") {
    return { kind: "configured_instructions", id: "configured_instructions", name: "Configured instructions" };
  }
  if (category === "system_prompt") {
    return { kind: "system_prompt", id: "system_prompt", name: "Model-request system prompts" };
  }
  if (category === "user_prompt" || category === "user_message") {
    return { kind: "user_prompt", id: "user_prompt", name: "User prompts" };
  }
  if (category === "assistant_output" || category === "assistant_message") {
    return { kind: "assistant_output", id: "assistant_output", name: "Assistant output" };
  }
  if (category === "assistant_thought") {
    return { kind: "assistant_thought", id: "assistant_thought", name: "Observed reasoning" };
  }
  return undefined;
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
  kind: "definition" | "arguments" | "result" | "skill" | "system_prompt" | "user_message" | "assistant_message" | "other";
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
  argumentEstimate?: ToolContentEstimate;
  resultEstimate?: ToolContentEstimate;
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

/** Content observed at a tool boundary, counted once; not model-request exposure or billing. */
export type ToolContentEstimate = {
  tokens: number | null;
  byteLength: number;
  estimate: TokenEstimate;
  partial: boolean;
};

export type CoverageCounts = Record<ContextCoverage, number>;

export type AttributionRankRow = {
  measurement: "estimated";
  tokenizationStatus: "unavailable" | "single" | "mixed";
  tokenEstimates: TokenEstimateSummary[];
  inputBytes: number | null;
  capability: Capability;
  calls: number;
  contentObservations: number;
  observedArgumentTokens: number | null;
  observedResultTokens: number | null;
  observedTotalTokens: number | null;
  observedArgumentCalls: number;
  observedResultCalls: number;
  payloadEstimates: TokenEstimate[];
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
  argumentEstimate: ToolContentEstimate | null;
  resultEstimate: ToolContentEstimate | null;
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

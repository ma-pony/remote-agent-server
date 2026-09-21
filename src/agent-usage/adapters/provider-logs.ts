import { metricNames, type UsageMetrics, type UsageObservation } from "../core/types.js";

export type ProviderLogKind = "codex_log" | "claude_log";
export type ParsedProviderUsage = { sourceSessionKey: string; observation: UsageObservation };
export type ProviderLogFormatErrorCode =
  | "provider_log_malformed"
  | "provider_log_unsupported"
  | "provider_log_invalid_metric";

export class ProviderLogFormatError extends Error {
  readonly name = "ProviderLogFormatError";

  constructor(readonly code: ProviderLogFormatErrorCode, readonly lineNumber: number | null = null) {
    super(code);
  }
}

type JsonObject = Record<string, unknown>;
type ParsedLine = { lineNumber: number; value: JsonObject };

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const objectAt = (value: unknown, lineNumber: number): JsonObject => {
  if (!isObject(value)) throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
  return value;
};

const optionalString = (value: unknown, lineNumber: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
  return value;
};

const requiredString = (value: unknown, lineNumber: number): string => {
  const result = optionalString(value, lineNumber);
  if (result === null) throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
  return result;
};

const timestamp = (value: unknown, lineNumber: number): string | null => {
  const result = optionalString(value, lineNumber);
  if (result !== null && !Number.isFinite(Date.parse(result))) {
    throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
  }
  return result;
};

const metric = (value: unknown, lineNumber: number, required = false): number | null => {
  if (value === undefined || value === null) {
    if (required) throw new ProviderLogFormatError("provider_log_invalid_metric", lineNumber);
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderLogFormatError("provider_log_invalid_metric", lineNumber);
  }
  return value;
};

const safeSum = (values: number[], lineNumber: number): number => {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new ProviderLogFormatError("provider_log_invalid_metric", lineNumber);
  return result;
};

const parseLines = (lines: string[]): ParsedLine[] => {
  const parsed: ParsedLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      parsed.push({ lineNumber: index + 1, value: objectAt(JSON.parse(line), index + 1) });
    } catch (error) {
      if (error instanceof ProviderLogFormatError) throw error;
      throw new ProviderLogFormatError("provider_log_malformed", index + 1);
    }
  }
  if (parsed.length === 0) throw new ProviderLogFormatError("provider_log_unsupported");
  return parsed;
};

const codexMetrics = (value: unknown, lineNumber: number): UsageMetrics => {
  const usage = objectAt(value, lineNumber);
  const input = metric(usage.input_tokens, lineNumber, true)!;
  const cacheRead = metric(usage.cached_input_tokens, lineNumber);
  const cacheWrite = metric(usage.cache_write_input_tokens, lineNumber);
  const output = metric(usage.output_tokens, lineNumber, true)!;
  const reasoning = metric(usage.reasoning_output_tokens, lineNumber);
  const reportedTotal = metric(usage.total_tokens, lineNumber, true)!;
  let uncached: number | null = null;
  if (cacheRead !== null && cacheWrite !== null) {
    uncached = input - cacheRead - cacheWrite;
    if (uncached < 0) throw new ProviderLogFormatError("provider_log_invalid_metric", lineNumber);
  }
  return {
    inputTotalTokens: input,
    inputUncachedTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTotalTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: reportedTotal
  };
};

const codexObservation = (
  sessionKey: string,
  lineNumber: number,
  timestampValue: string | null,
  suffix: "total" | "last",
  metrics: UsageMetrics,
  turnId: string | null,
  model: string | null
): ParsedProviderUsage => {
  const lineIdentity = `line:${lineNumber}`;
  const isTotal = suffix === "total";
  return {
    sourceSessionKey: sessionKey,
    observation: {
      eventId: `codex:${sessionKey}:${lineIdentity}:${suffix}`,
      sourceId: `codex-log:${sessionKey}`,
      sourceVersion: "provider-logs/1",
      scope: isTotal ? "provider_session" : "unknown",
      semantics: isTotal ? "cumulative" : "snapshot",
      coverageId: isTotal ? `codex-session:${sessionKey}` : `codex-last-usage:${sessionKey}:${lineIdentity}`,
      invocationId: null,
      executionId: turnId,
      providerEpochId: `codex-session:${sessionKey}`,
      occurredAt: isTotal ? null : timestampValue,
      finality: isTotal ? "interim" : "unknown",
      revision: lineNumber,
      measurement: "reported",
      normalizationProfile: "codex-token-usage-v1",
      metrics,
      runtimeKind: "codex",
      model
    }
  };
};

export type ProviderLogState = {
  sessionKey?: string; previous?: { metrics: UsageMetrics; time: string | null };
  latestTotal?: ParsedProviderUsage; turnId?: string | null; model?: string | null;
  sawTokenCount?: boolean; sawUsage?: boolean;
};

const parseCodex = (lines: ParsedLine[], state?: ProviderLogState): ParsedProviderUsage[] => {
  const sessionKeys = new Set<string>(state?.sessionKey ? [state.sessionKey] : []);
  for (const { lineNumber, value } of lines) {
    if (value.type !== "session_meta") continue;
    const payload = objectAt(value.payload, lineNumber);
    sessionKeys.add(requiredString(payload.id, lineNumber));
  }
  if (sessionKeys.size !== 1) throw new ProviderLogFormatError("provider_log_unsupported");
  const sessionKey = [...sessionKeys][0]!;
  const result: ParsedProviderUsage[] = [];
  let sawTokenCount = state?.sawTokenCount ?? false;
  let previous = state?.previous;
  let latestTotal = state?.latestTotal;
  let turnId = state?.turnId ?? null;
  let model = state?.model ?? null;

  for (const { lineNumber, value } of lines) {
    if (value.type === "turn_context") {
      const payload = objectAt(value.payload, lineNumber);
      turnId = optionalString(payload.turn_id, lineNumber);
      model = optionalString(payload.model, lineNumber);
      continue;
    }
    if (value.type !== "event_msg") continue;
    const payload = objectAt(value.payload, lineNumber);
    if (payload.type === "task_complete" && latestTotal && turnId !== null && latestTotal.observation.executionId === turnId && payload.turn_id === turnId) {
      result.push({ ...latestTotal, observation: { ...latestTotal.observation,
        eventId: `codex:${sessionKey}:terminal:${lineNumber}`, revision: lineNumber, finality: "final" } });
      continue;
    }
    if (payload.type !== "token_count") continue;
    sawTokenCount = true;
    if (payload.info === null) continue;
    const info = objectAt(payload.info, lineNumber);
    const occurredAt = timestamp(value.timestamp, lineNumber);
    if (info.total_token_usage !== undefined && info.total_token_usage !== null) {
      const metrics = codexMetrics(info.total_token_usage, lineNumber);
      latestTotal = codexObservation(sessionKey, lineNumber, occurredAt, "total", metrics, turnId, model);
      result.push(latestTotal);
      const monotonic = previous && metricNames.every((key) => previous!.metrics[key] === null
        || metrics[key] !== null && metrics[key]! >= previous!.metrics[key]!);
      if (monotonic && previous!.time && occurredAt && Date.parse(occurredAt) >= Date.parse(previous!.time)
        && new Date(occurredAt).toISOString().slice(0, 10) === new Date(previous!.time).toISOString().slice(0, 10)
        && metrics.totalTokens! > previous!.metrics.totalTokens!) {
        const delta = Object.fromEntries(metricNames.map((key) => [key,
          metrics[key] === null || previous!.metrics[key] === null ? null : metrics[key]! - previous!.metrics[key]!
        ])) as UsageMetrics;
        result.push({ sourceSessionKey: sessionKey, observation: {
          ...latestTotal.observation, eventId: `codex:${sessionKey}:interval:${lineNumber}`,
          coverageId: `codex-interval:${sessionKey}:${lineNumber}`, scope: "interval", semantics: "snapshot",
          intervalStart: new Date(previous!.time).toISOString(), occurredAt, metrics: delta,
          measurement: "derived", finality: "final"
        } });
      }
      // A counter decrease cannot establish a new baseline under the same provider epoch.
      if (!previous || monotonic && metricNames.some((key) => metrics[key] !== previous!.metrics[key])) previous = { metrics, time: occurredAt };
      else if (!monotonic) previous = { ...previous, time: null };
    }
    if (info.last_token_usage !== undefined && info.last_token_usage !== null && info.total_token_usage == null) {
      result.push(codexObservation(sessionKey, lineNumber, occurredAt, "last",
        codexMetrics(info.last_token_usage, lineNumber), turnId, model));
    }
    if (info.total_token_usage === undefined && info.last_token_usage === undefined) {
      throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
    }
  }
  if (state) Object.assign(state, { sessionKey, previous, latestTotal, turnId, model, sawTokenCount });
  else if (result.length === 0 && !sawTokenCount) throw new ProviderLogFormatError("provider_log_unsupported");
  return result;
};

const claudeMetrics = (value: unknown, lineNumber: number): UsageMetrics => {
  const usage = objectAt(value, lineNumber);
  const inputUncached = metric(usage.input_tokens, lineNumber, true)!;
  const cacheRead = metric(usage.cache_read_input_tokens, lineNumber);
  const cacheWrite = metric(usage.cache_creation_input_tokens, lineNumber);
  const output = metric(usage.output_tokens, lineNumber, true)!;
  const outputDetails = usage.output_tokens_details === undefined || usage.output_tokens_details === null
    ? null : objectAt(usage.output_tokens_details, lineNumber);
  const reasoning = outputDetails === null ? null : metric(outputDetails.thinking_tokens, lineNumber);
  const inputTotal = cacheRead === null || cacheWrite === null
    ? null : safeSum([inputUncached, cacheRead, cacheWrite], lineNumber);
  return {
    inputTotalTokens: inputTotal,
    inputUncachedTokens: inputUncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTotalTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: inputTotal === null ? null : safeSum([inputTotal, output], lineNumber)
  };
};

const parseClaude = (lines: ParsedLine[], incremental = false): ParsedProviderUsage[] => {
  const result: ParsedProviderUsage[] = [];
  for (const { lineNumber, value } of lines) {
    if (value.type !== "assistant") continue;
    const message = objectAt(value.message, lineNumber);
    if (message.usage === undefined || message.usage === null) continue;
    if (message.role !== "assistant") throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
    const sessionKey = requiredString(value.sessionId, lineNumber);
    const messageId = requiredString(message.id, lineNumber);
    optionalString(value.requestId, lineNumber);
    const entryId = optionalString(value.uuid, lineNumber) ?? `line:${lineNumber}`;
    const stopReason = message.stop_reason;
    if (stopReason !== undefined && stopReason !== null && typeof stopReason !== "string") {
      throw new ProviderLogFormatError("provider_log_unsupported", lineNumber);
    }
    result.push({
      sourceSessionKey: sessionKey,
      observation: {
        eventId: `claude:${sessionKey}:entry:${entryId}`,
        sourceId: `claude-log:${sessionKey}`,
        sourceVersion: "provider-logs/1",
        scope: "model_request",
        semantics: "snapshot",
        coverageId: `claude-message:${messageId}`,
        invocationId: `claude-message:${messageId}`,
        executionId: null,
        providerEpochId: `claude-session:${sessionKey}`,
        occurredAt: timestamp(value.timestamp, lineNumber),
        finality: typeof stopReason === "string" ? "final" : "interim",
        revision: lineNumber,
        measurement: "reported",
        normalizationProfile: "claude-messages-usage-v1",
        metrics: claudeMetrics(message.usage, lineNumber),
        runtimeKind: "claude_code",
        model: optionalString(message.model, lineNumber)
      }
    });
  }
  if (result.length === 0 && !incremental) throw new ProviderLogFormatError("provider_log_unsupported");
  return result;
};

/** Parse already-authorized JSONL content; this adapter never discovers or opens Provider files. */
export const parseProviderLog = (kind: ProviderLogKind, lines: string[]): ParsedProviderUsage[] => {
  const parsed = parseLines(lines);
  return kind === "codex_log" ? parseCodex(parsed) : parseClaude(parsed);
};

/** Resumable JSONL parser. Snapshots contain only identifiers and normalized counters. */
export const createProviderLogParser = (kind: ProviderLogKind, checkpoint?: unknown) => {
  const state: ProviderLogState = checkpoint ? structuredClone(checkpoint) as ProviderLogState : {};
  return {
    parseLine(text: string, lineNumber: number): ParsedProviderUsage[] {
      if (!text.trim()) return [];
      let value: JsonObject;
      try { value = objectAt(JSON.parse(text), lineNumber); }
      catch (error) {
        if (error instanceof ProviderLogFormatError) throw error;
        throw new ProviderLogFormatError("provider_log_malformed", lineNumber);
      }
      const result = kind === "codex_log" ? parseCodex([{ value, lineNumber }], state)
        : parseClaude([{ value, lineNumber }], true);
      if (result.length) state.sawUsage = true;
      return result;
    },
    snapshot: (): ProviderLogState => structuredClone(state),
    validate(): void {
      if (kind === "codex_log" ? !state.sawTokenCount : !state.sawUsage) throw new ProviderLogFormatError("provider_log_unsupported");
    }
  };
};

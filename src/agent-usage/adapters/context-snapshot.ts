import { createHash } from "node:crypto";
import { z } from "zod";
import { capabilityKinds, contentCapability, type Capability, type ContextBlock, type InvocationInput } from "../core/context-types.js";
import { normalizeUsage } from "../core/usage.js";
import type { UsageMetrics } from "../core/types.js";
import type { UsageSourceEntry } from "../source-coordinator.js";

const capabilitySchema = z.object({ id: z.string().min(1), kind: z.enum(capabilityKinds), name: z.string().min(1),
  serverId: z.string().optional(), version: z.string().optional() });
const snapshotSchema = z.object({
  format: z.literal("context-snapshot-v1"), revision: z.number().int().nonnegative().safe(),
  historyComplete: z.boolean().default(false),
  capabilities: z.array(z.object({ runtimeName: z.string().min(1), capability: capabilitySchema,
    tags: z.array(capabilitySchema).optional() })).max(2000).default([]),
  requests: z.array(z.object({
    id: z.string().min(1), session_id: z.string().min(1), timestamp: z.string(), provider: z.string(), endpoint: z.string(),
    modelProvider: z.string().min(1).max(100).nullable().optional(),
    agent: z.string().nullable().optional(), model: z.string().nullable().optional(),
    context_fidelity: z.enum(["complete", "partial", "opaque"]).default("partial"),
    response_complete: z.boolean().default(false),
    canonical_request_body: z.string().nullable().optional(), canonical_response_body: z.string().nullable().optional()
  })).max(10000)
});
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const objects = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.map(object).filter((item) => item !== null) : [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const jsonBody = (value: string | null | undefined): ObjectValue | null => value ? object(JSON.parse(value)) : null;
const nameOf = (value: ObjectValue): string | null => typeof value.name === "string" ? value.name
  : typeof object(value.function)?.name === "string" ? object(value.function)!.name as string : null;
const callId = (value: ObjectValue): string | null => typeof value.call_id === "string" ? value.call_id
  : typeof value.tool_use_id === "string" ? value.tool_use_id : typeof value.tool_call_id === "string" ? value.tool_call_id
    : typeof value.id === "string" ? value.id : null;
const runtimeKind = (value: string | null | undefined): string | null | undefined =>
  value === "claude-code" ? "claude_code" : value;

const requestItems = (body: ObjectValue | null): ObjectValue[] => {
  if (!body) return [];
  const items = [...objects(body.input)];
  for (const item of objects(body.input)) if (!isResult(item)) items.push(...objects(item.content).map((part) => ({ ...part, role: item.role })));
  for (const message of objects(body.messages)) {
    items.push(message);
    if (!isResult(message)) items.push(...objects(message.content).map((part) => ({ ...part, role: message.role })), ...objects(message.tool_calls));
  }
  return items;
};
const responseItems = (body: ObjectValue | null): ObjectValue[] => {
  if (!body) return [];
  return [...objects(body.output), ...objects(body.content), ...objects(body.choices).flatMap((choice) => objects(object(choice.message)?.tool_calls))];
};
const isCall = (item: ObjectValue) => item.type === "function_call" || item.type === "tool_use" || item.type === "function" && object(item.function) !== null;
const isResult = (item: ObjectValue) => item.type === "function_call_output" || item.type === "tool_result" || item.role === "tool";

const usage = (body: ObjectValue | null, endpoint: string): { metrics: UsageMetrics; profile: string | null } => {
  const raw = object(body?.usage);
  if (!raw) return { metrics: normalizeUsage({}), profile: null };
  if (endpoint.includes("/messages")) {
    const metrics = normalizeUsage({ inputUncachedTokens: raw.input_tokens, cacheReadTokens: raw.cache_read_input_tokens,
      cacheWriteTokens: raw.cache_creation_input_tokens, outputTotalTokens: raw.output_tokens });
    if (metrics.inputUncachedTokens !== null && metrics.cacheReadTokens !== null && metrics.cacheWriteTokens !== null) {
      metrics.inputTotalTokens = metrics.inputUncachedTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
    }
    return { metrics: normalizeUsage(metrics), profile: "anthropic-messages-v1" };
  }
  if (endpoint.includes("/responses") || endpoint.includes("/chat/completions")) {
    const responses = endpoint.includes("/responses");
    return { metrics: normalizeUsage({ inputTotalTokens: responses ? raw.input_tokens : raw.prompt_tokens,
      outputTotalTokens: responses ? raw.output_tokens : raw.completion_tokens, totalTokens: raw.total_tokens,
      cacheReadTokens: object(responses ? raw.input_tokens_details : raw.prompt_tokens_details)?.cached_tokens,
      reasoningOutputTokens: object(responses ? raw.output_tokens_details : raw.completion_tokens_details)?.reasoning_tokens }),
      profile: responses ? "openai-responses-v1" : "openai-chat-v1" };
  }
  return { metrics: normalizeUsage({}), profile: null };
};

export type CanonicalCall = { name: string; capability?: Capability; tags?: Capability[] };
export type CanonicalSnapshot = {
  revision: number; historyComplete: boolean;
  capabilities: Array<{ runtimeName: string; capability: Capability; tags?: Capability[] }>;
  requests: Array<{ record: Omit<z.infer<typeof snapshotSchema>["requests"][number], "canonical_request_body" | "canonical_response_body"> & { invocationId?: string };
    request: ObjectValue | null; response: ObjectValue | null }>;
};
/** Shared in-memory normalizer; file import only handles decoding and validation. */
export const normalizeCanonicalExchanges = (snapshot: CanonicalSnapshot, calls = new Map<string, CanonicalCall>(),
  resolvers: {
    callTags?: (name: string, args: unknown) => Capability[];
    capability?: (name: string, args?: unknown) => Capability | undefined;
  } = {}): UsageSourceEntry[] => {
  const aliases = new Map(snapshot.capabilities.map((entry) => [entry.runtimeName, entry]));
  if (aliases.size !== snapshot.capabilities.length) throw new Error("context_snapshot_alias_conflict");
  const rows = snapshot.requests;
  for (const { record, request, response } of rows) {
    for (const item of [...requestItems(request), ...responseItems(response)]) {
      const id = callId(item), name = nameOf(item);
      if (isCall(item) && id && name) {
        const key = `${record.session_id}:${id}`;
        const previous = calls.get(key);
        if (previous && previous.name !== name) throw new Error("context_snapshot_call_conflict");
        const args = item.arguments ?? item.input ?? object(item.function)?.arguments;
        // A replayed call belongs to its original projection, including a confirmed empty tag set.
        const capability = previous?.capability ?? aliases.get(name)?.capability ?? resolvers.capability?.(name, args);
        const tags = previous?.tags ?? (args === undefined ? undefined : resolvers.callTags?.(name, args));
        if (!previous || previous.capability !== capability || previous.tags !== tags) {
          calls.set(key, { name, capability, tags });
        }
      }
    }
  }
  return rows.map(({ record, request, response }) => {
    const occurredAt = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(record.timestamp) ? record.timestamp : `${record.timestamp}Z`).toISOString();
    const invocationId = record.invocationId ?? `context-snapshot:${record.session_id}:${record.id}`;
    const epoch = `context-snapshot:${record.session_id}`;
    const sourceId = "context-snapshot";
    const blocks: ContextBlock[] = [];
    const invocations: InvocationInput[] = [];
    const references = (name: string) => {
      const alias = aliases.get(name);
      const unknown: Capability = { id: `unknown:${record.provider}:${hash(name)}`, name, kind: "unknown" };
      return [alias?.capability ?? resolvers.capability?.(name) ?? unknown, ...alias?.tags ?? []]
        .map((capability) => ({ capability, evidence: "direct" as const }));
    };
    const block = (kind: ContextBlock["kind"], value: unknown, identity: string, name?: string, toolInvocationId?: string) => {
      const content = typeof value === "string" ? { identity, modality: "text" as const, text: value }
        : { identity, modality: "unsupported" as const, mediaType: object(value)?.type as string | undefined };
      const call = toolInvocationId ? calls.get(toolInvocationId) : undefined;
      const contentOwner = contentCapability(kind);
      const primary = contentOwner ? [{ capability: contentOwner, evidence: "direct" as const }]
        : call?.capability ? [{ capability: call.capability, evidence: "direct" as const }]
        : references(name ?? "unattributed");
      const tags = (call?.tags ?? []).map((capability) => ({ capability, evidence: "direct" as const }));
      blocks.push({ position: blocks.length, kind, content, capabilities: [...primary, ...tags],
        ...(toolInvocationId ? { toolInvocationId } : {}) });
    };
    for (const tool of objects(request?.tools)) {
      const name = nameOf(tool) ?? "unknown-definition";
      block("definition", JSON.stringify(tool), `definition:${name}:${hash(JSON.stringify(tool))}`, name);
    }
    if (typeof request?.instructions === "string") block("system_prompt", request.instructions, `${invocationId}:instructions`);
    if (typeof request?.system === "string") block("system_prompt", request.system, `${invocationId}:system`);
    else if (Array.isArray(request?.system)) {
      for (const [index, part] of request.system.entries()) {
        block("system_prompt", object(part)?.type === "text" ? object(part)?.text : part, `${invocationId}:system:${index}`);
      }
    }
    if (typeof request?.input === "string") block("user_message", request.input, `${invocationId}:input`);
    for (const item of requestItems(request)) {
      const id = callId(item);
      const toolId = id ? `${record.session_id}:${id}` : undefined;
      const name = nameOf(item) ?? (toolId ? calls.get(toolId)?.name : undefined) ?? "unknown-tool";
      const contentKind = item.role === "system" || item.role === "developer" ? "system_prompt"
        : item.role === "user" ? "user_message" : item.role === "assistant" ? "assistant_message" : "other";
      if (isCall(item)) {
        const args = item.arguments ?? item.input ?? object(item.function)?.arguments;
        block("arguments", typeof args === "string" ? args : args === undefined ? undefined : JSON.stringify(args),
          `${toolId ?? invocationId}:arguments`, name, toolId);
      } else if (isResult(item)) {
        const value = item.output ?? item.content;
        if (Array.isArray(value)) {
          for (const [index, part] of value.entries()) block("result", object(part)?.type === "text" ? object(part)?.text : part,
            `${toolId ?? invocationId}:result:${index}`, name, toolId);
        } else block("result", value, `${toolId ?? invocationId}:result`, name, toolId);
        if (toolId) invocations.push({ invocationId: toolId, providerEpochId: epoch, executionId: null,
          runtimeKind: runtimeKind(record.agent) ?? null, executionEvidence: "unknown", origin: "context",
          capability: calls.get(toolId)?.capability ?? references(name)[0]!.capability, startedAt: null, endedAt: null,
          status: item.is_error === true ? "tool_error" : "succeeded", sourceId, revision: snapshot.revision, rawResultBytes: null });
      } else if (typeof item.content === "string") block(contentKind, item.content, `${invocationId}:content:${blocks.length}`);
      else if (typeof item.text === "string") block(contentKind, item.text, `${invocationId}:text:${blocks.length}`);
      else if (!Array.isArray(item.content) && !Array.isArray(item.tool_calls)) block(contentKind, item, `${invocationId}:opaque:${blocks.length}`);
    }
    const accounting = usage(response, record.endpoint);
    const model = typeof response?.model === "string" && response.model ? response.model
      : record.model ?? (typeof request?.model === "string" ? request.model : null);
    const runtime = runtimeKind(record.agent);
    const supportedEndpoint = ["/messages", "/responses", "/chat/completions"].some((path) => record.endpoint.endsWith(path));
    const coverage = request === null ? "none" : record.context_fidelity === "opaque" ? "opaque"
      : !supportedEndpoint || record.context_fidelity === "partial" || request.previous_response_id || request.conversation ? "partial" : "full";
    return {
      sourceSessionKey: record.session_id,
      observation: { eventId: `${invocationId}:${snapshot.revision}`, sourceId, sourceVersion: "context-snapshot/1",
        scope: "model_request", semantics: "snapshot", coverageId: invocationId, invocationId, executionId: null,
        providerEpochId: epoch, occurredAt, finality: record.response_complete ? "final" : "interim", revision: snapshot.revision,
        measurement: "reported", normalizationProfile: accounting.profile, metrics: accounting.metrics,
        runtimeKind: runtime ?? undefined, model },
      context: { invocationId, providerEpochId: epoch, sourceId, revision: snapshot.revision, occurredAt,
        runtimeKind: runtime ?? null, model,
        modelProvider: record.modelProvider ?? null,
        coverage, historyComplete: snapshot.historyComplete, blocks, reportedInputTokens: accounting.metrics.inputTotalTokens },
      invocations
    };
  });
};

/** Backward-compatible manual Context Snapshot import. */
export const parseContextSnapshot = (text: string): UsageSourceEntry[] => {
  const snapshot = snapshotSchema.parse(JSON.parse(text));
  return normalizeCanonicalExchanges({ ...snapshot, requests: snapshot.requests.map((record) => ({ record,
    request: jsonBody(record.canonical_request_body), response: jsonBody(record.canonical_response_body) })) });
};

import { UsageError } from "../core/errors.js";
import { stableHash } from "../core/context.js";
import { contentCapability, type Capability, type ContextBlock, type ModelContextInput, type ToolContentEstimate } from "../core/context-types.js";
import { capturedToolCapability } from "../core/tool-capabilities.js";
import type { UsageSourceEntry } from "../source-coordinator.js";
import { codexMetrics, createProviderLogParser, type ProviderLogKind } from "./provider-logs.js";
import type { IncrementalUsageParser } from "./file-source.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
type MeasuredBlock = ContextBlock & { measured: ToolContentEstimate };
type Call = { name: string; capabilities: Capability[] };
type TranscriptState = {
  session: string; model: string | null; total: number | null; history: MeasuredBlock[];
  system: MeasuredBlock[]; pending: Record<string, MeasuredBlock[]>; calls: Record<string, Call>;
  lastRequest?: string; context?: ModelContextInput; seenConfigured: boolean; lastUser?: string;
  dynamicTools?: boolean;
};
export type TranscriptProfile = {
  instructions?: string;
  tools: Array<{ runtimeName: string; capability: Capability; definition: unknown }>;
};
export type TranscriptOptions = {
  initialModel?: string | null;
  measure(text: string, model: string | null): Promise<ToolContentEstimate>;
  profile(occurredAt: string | null): TranscriptProfile;
  tags(name: string, args: unknown, occurredAt: string | null): Capability[];
};

/** Reconstruct visible input at usage boundaries. State contains counts and identities, never message bodies. */
export const createTranscriptParser = (kind: ProviderLogKind, options: TranscriptOptions, checkpoint?: unknown): IncrementalUsageParser => {
  const saved = checkpoint as { usage?: unknown; transcript?: TranscriptState } | undefined;
  const usage = createProviderLogParser(kind, saved?.usage);
  const state: TranscriptState = saved?.transcript ? structuredClone(saved.transcript) : {
    session: "", model: options.initialModel ?? null, total: null, history: [], system: [], pending: {}, calls: {}, seenConfigured: false
  };
  const runtime = kind === "codex_log" ? "codex" : "claude_code";
  let profile: TranscriptProfile = { tools: [] };
  let profileLoaded = false;
  let definitions: MeasuredBlock[] | undefined;
  let definitionsModel: string | null = null;
  let occurredAt: string | null = null;

  const measured = async (text: string): Promise<ToolContentEstimate> => {
    const result = await options.measure(text, state.model);
    if (result.estimate.reason === "tokenizer_pending") throw new UsageError("usage_tokenizer_pending");
    return result;
  };
  const merge = (target: MeasuredBlock[], incoming: MeasuredBlock[]) => {
    for (const block of incoming) {
      const key = stableHash(block.kind, JSON.stringify(block.capabilities), JSON.stringify(block.measured.estimate), block.resultFirstUse ?? "");
      const previous = target.find(item => item.content.identity === key);
      if (previous) {
        previous.measured = { ...previous.measured, byteLength: previous.measured.byteLength + block.measured.byteLength,
          tokens: previous.measured.tokens === null || block.measured.tokens === null ? null : previous.measured.tokens + block.measured.tokens,
          partial: previous.measured.partial || block.measured.partial };
      } else target.push({ ...structuredClone(block), content: { identity: key, modality: "text", text: "" } });
    }
  };
  const block = async (text: string, blockKind: ContextBlock["kind"], capabilities: Capability[]): Promise<MeasuredBlock[]> => {
    if (!text) return [];
    return [{ position: 0, kind: blockKind, content: { identity: stableHash(text), modality: "text", text: "" },
      capabilities: capabilities.map(capability => ({ capability, evidence: "inferred" })), measured: await measured(text),
      ...(blockKind === "result" ? { resultFirstUse: "first" as const } : {}) }];
  };
  const message = async (text: string, role: string): Promise<MeasuredBlock[]> => {
    const category = role === "assistant" ? "assistant_output" : role === "reasoning" ? "assistant_thought"
      : role === "user" ? "user_prompt" : "system_prompt";
    const blockKind = role === "assistant" ? "assistant_message" : role === "user" ? "user_message"
      : role === "reasoning" ? "other" : "system_prompt";
    const instructions = profile.instructions;
    if (instructions && text.includes(instructions)) {
      state.seenConfigured = true;
      const parts = text.split(instructions);
      const result = await block(parts.join(""), blockKind, [contentCapability(category)!]);
      for (let index = 1; index < parts.length; index++) result.push(...await block(instructions, "system_prompt", [contentCapability("configured_instructions")!]));
      return result;
    }
    return block(text, blockKind, [contentCapability(category)!]);
  };
  const callCapability = (name: string, args: unknown): Capability => profile.tools.find(tool => tool.runtimeName === name)?.capability
    ?? capturedToolCapability(runtime, name, args)
    ?? (/^mcp__([^]+?)__(.+)$/.test(name) ? (() => {
      const match = /^mcp__([^]+?)__(.+)$/.exec(name)!;
      return { id: `mcp:runtime:${match[1]}:${match[2]}`, kind: "mcp_tool", name: match[2]!, serverId: `runtime:${match[1]}` } as Capability;
    })() : { id: `native:${runtime}:${name}`, kind: "builtin_tool", name });
  const textParts = (value: unknown): string => typeof value === "string" ? value
    : list(value).map(part => string(part.text) ?? string(part.thinking) ?? "").join("\n");
  const itemBlocks = async (item: ObjectValue, key: string, skillTags: Capability[] = []): Promise<MeasuredBlock[]> => {
    const type = string(item.type);
    if (type === "tool_search_output") {
      state.dynamicTools = true;
      delete state.calls[string(item.call_id) ?? key];
      const blocks: MeasuredBlock[] = [];
      for (const entry of list(item.tools)) {
        const namespace = entry.type === "namespace" ? string(entry.name) : undefined;
        for (const definition of namespace ? list(entry.tools) : [entry]) {
          const name = namespace ? `${namespace}__${String(definition.name)}` : string(definition.name) ?? "unknown-tool";
          blocks.push(...await block(JSON.stringify(definition), "definition", [callCapability(name, undefined)]));
        }
      }
      return blocks;
    }
    if (["function_call", "custom_tool_call", "tool_use", "tool_search_call"].includes(type ?? "")) {
      const id = string(item.call_id) ?? string(item.id) ?? key;
      if (type === "tool_search_call") state.dynamicTools = true;
      const baseName = string(item.name) ?? (type === "tool_search_call" ? "tool_search" : "unknown-tool");
      const namespace = string(item.namespace);
      const name = namespace?.startsWith("mcp__") ? `${namespace}__${baseName}` : baseName;
      const args = item.arguments ?? item.input;
      const capabilities = [callCapability(name, args), ...options.tags(name, args, occurredAt)];
      state.calls[id] = { name, capabilities };
      return block(typeof args === "string" ? args : JSON.stringify(args ?? {}), "arguments", capabilities);
    }
    if (["function_call_output", "custom_tool_call_output", "tool_result"].includes(type ?? "")) {
      const id = string(item.call_id) ?? string(item.tool_use_id) ?? key;
      const call = state.calls[id];
      // Claude emits Skill instructions as separate user messages after the tool result.
      if (kind !== "claude_log" || call?.name !== "Skill") delete state.calls[id];
      const value = item.output ?? item.content;
      return block(textParts(value), "result", call?.capabilities ?? [{ id: "unmatched_tool_result", kind: "unknown", name: "Unmatched tool result" }]);
    }
    if (type === "reasoning") return message(textParts(item.content) || textParts(item.summary), "reasoning");
    if (type === "thinking") return message(string(item.thinking) ?? "", "reasoning");
    const role = string(item.role) ?? "assistant";
    if (Array.isArray(item.content)) {
      const blocks: MeasuredBlock[] = [];
      for (const [index, part] of list(item.content).entries()) {
        if (["tool_use", "tool_result", "thinking"].includes(String(part.type))) blocks.push(...await itemBlocks(part, `${key}:${index}`));
        else if (typeof part.text === "string") blocks.push(...await (skillTags.length
          ? block(part.text, "skill", skillTags) : message(part.text, role)));
      }
      return blocks;
    }
    const text = string(item.content) ?? string(item.text) ?? "";
    return skillTags.length ? block(text, "skill", skillTags) : message(text, role);
  };
  const promote = () => {
    for (const blocks of Object.values(state.pending)) merge(state.history, blocks);
    state.pending = {};
  };
  const snapshot = async (invocationId: string, revision: number, reportedInputTokens: number | null): Promise<ModelContextInput> => {
    const blocks: ContextBlock[] = structuredClone([...state.system, ...state.history]);
    if (!state.dynamicTools) {
      if (!definitions || definitionsModel !== state.model) {
        definitions = [];
        for (const tool of profile.tools) definitions.push(...await block(JSON.stringify(tool.definition), "definition", [tool.capability]));
        definitionsModel = state.model;
      }
      blocks.push(...structuredClone(definitions));
    }
    if (profile.instructions && !state.seenConfigured) {
      blocks.push(...await block(profile.instructions, "system_prompt", [contentCapability("configured_instructions")!]));
    }
    const context: ModelContextInput = { invocationId, providerEpochId: `${runtime}-session:${state.session}`, sourceId: "transcript",
      revision, occurredAt, runtimeKind: runtime, model: state.model, coverage: "partial", historyComplete: true,
      basis: "transcript", reportedInputTokens, blocks: blocks.map((item, position) => ({ ...item, position })) };
    // Fresh results become repeats only after the request that first includes them.
    const history = state.history.map(item => item.kind === "result" ? { ...item, resultFirstUse: "repeat" as const } : item);
    state.history = []; merge(state.history, history);
    return context;
  };
  return {
    async parseLine(text, lineNumber): Promise<UsageSourceEntry[]> {
      const before = kind === "codex_log" ? usage.snapshot().previous : undefined;
      const entries: UsageSourceEntry[] = usage.parseLine(text, lineNumber).map(entry => ({ ...entry }));
      if (!text.trim()) return entries;
      const value = object(JSON.parse(text));
      const time = string(value.timestamp);
      occurredAt = time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
      if (!profileLoaded || value.type === "turn_context" || kind === "claude_log" && value.type === "user") {
        profile = options.profile(occurredAt); profileLoaded = true; definitions = undefined;
      }
      if (kind === "codex_log") {
        const payload = object(value.payload);
        if (value.type === "session_meta") {
          state.session = string(payload.id) ?? state.session;
          const instructions = string(object(payload.base_instructions).text);
          if (instructions) state.system = await message(instructions, "system");
        } else if (value.type === "turn_context") {
          state.model = string(payload.model) ?? state.model;
        } else if (value.type === "response_item") {
          const blocks = await itemBlocks(payload, String(lineNumber));
          const output = ["function_call", "custom_tool_call", "tool_search_call", "reasoning"].includes(String(payload.type)) || payload.role === "assistant";
          if (output) state.pending[String(lineNumber)] = blocks;
          else if (Object.keys(state.pending).length && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(payload.type))) state.pending[String(lineNumber)] = blocks;
          else merge(state.history, blocks);
        } else if (value.type === "compacted") {
          promote(); state.history = []; state.seenConfigured = false;
          for (const [index, item] of list(payload.replacement_history).entries()) merge(state.history, await itemBlocks(item, `compact:${index}`));
          if (!Array.isArray(payload.replacement_history) && typeof payload.message === "string") merge(state.history, await message(payload.message, "user"));
        } else if (value.type === "event_msg" && payload.type === "token_count") {
          const info = object(payload.info), total = object(info.total_token_usage), last = object(info.last_token_usage);
          const count = typeof total.total_tokens === "number" ? total.total_tokens : null;
          if (count !== null && count > (state.total ?? 0)) {
            const entry = entries.find(item => item.observation.scope === "provider_session");
            if (entry) {
              entry.context = await snapshot(`transcript:codex:${state.session}:${lineNumber}`, lineNumber * 2,
                typeof last.input_tokens === "number" ? last.input_tokens : state.total === null && typeof total.input_tokens === "number" ? total.input_tokens : null);
              // A matching last-usage report locates this counter increment at its completion time,
              // including the first request and midnight crossings. It does not invent a native request ID.
              if (occurredAt && info.last_token_usage) {
                const metrics = codexMetrics(last, lineNumber);
                if (["inputTotalTokens", "outputTotalTokens", "totalTokens"].every(key => {
                  const metric = key as "inputTotalTokens" | "outputTotalTokens" | "totalTokens";
                  return entry.observation.metrics[metric]! - (before?.metrics[metric] ?? 0) === metrics[metric];
                })) {
                  const interval: UsageSourceEntry = { sourceSessionKey: state.session, observation: {
                    ...entry.observation, scope: "interval", semantics: "snapshot", occurredAt, intervalStart: occurredAt,
                    eventId: `codex:${state.session}:transcript-interval:${lineNumber}`, coverageId: `codex-interval:${state.session}:${lineNumber}`,
                    revision: lineNumber + 1, sourceVersion: "provider-transcript/3", metrics, finality: "final", measurement: "derived"
                  } };
                  const index = entries.findIndex(item => item.observation.scope === "interval");
                  if (index >= 0) entries[index] = interval;
                  else entries.push(interval);
                }
              }
            }
            promote();
          }
          if (count !== null) state.total = count;
        }
      } else {
        state.session = string(value.sessionId) ?? state.session;
        const item = object(value.message);
        if (value.type === "system" && value.subtype === "compact_boundary") {
          state.history = []; state.pending = {}; state.calls = {}; state.seenConfigured = false; delete state.context; delete state.lastRequest;
        } else if (value.type === "user" && (typeof value.uuid !== "string" || value.uuid !== state.lastUser)) {
          promote();
          if (value.isCompactSummary === true) { state.history = []; state.seenConfigured = false; }
          const call = state.calls[string(value.sourceToolUseID) ?? ""];
          const tags = call?.name === "Skill" ? call.capabilities.filter(tag => tag.kind === "skill" || tag.kind === "plugin") : [];
          merge(state.history, await itemBlocks(item, String(lineNumber), tags));
          state.lastUser = string(value.uuid);
        } else if (value.type === "assistant") {
          state.model = string(item.model) ?? state.model;
          const id = string(item.id);
          const entry = entries[0];
          if (id && entry) {
            if (state.lastRequest !== id) {
              promote();
              state.context = await snapshot(`claude-message:${id}`, lineNumber, entry.observation.metrics.inputTotalTokens ?? null);
              for (const [callId, call] of Object.entries(state.calls)) if (call.name === "Skill") delete state.calls[callId];
              state.lastRequest = id;
            }
            entry.context = { ...structuredClone(state.context!), revision: lineNumber, reportedInputTokens: entry.observation.metrics.inputTotalTokens };
            for (const [index, part] of list(item.content).entries()) {
              state.pending[`${id}:${String(part.type)}:${string(part.id) ?? index}`] = await itemBlocks({ ...part, role: "assistant" }, String(lineNumber));
            }
          }
        }
      }
      return entries;
    },
    snapshot: () => ({ usage: usage.snapshot(), transcript: structuredClone(state) }),
    validate: () => usage.validate()
  };
};

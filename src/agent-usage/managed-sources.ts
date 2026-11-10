import { UsageError } from "./core/errors.js";
import { loadModelTokenizers } from "./tokenizer-config.js";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { HostUsageCollector } from "./host-collector.js";
import { FileUsageSource } from "./adapters/file-source.js";
import { parseProviderLog, createProviderLogParser } from "./adapters/provider-logs.js";
import { parseContextSnapshot } from "./adapters/context-snapshot.js";
import { createTranscriptParser } from "./adapters/transcript-context.js";
import type { SourceConfig, SourceRecord } from "./source-coordinator.js";

export type SourceRegistration = {
  sourceKey: string;
  kind: "codex_log" | "claude_log" | "context_snapshot";
  inputRef: { importRootId: string; relativePath: string } | { providerSessionRef: string; executionContextRef?: string; relativePath: string };
  mappings: Array<{ sourceSessionKey: string; sessionId: string; providerEpochId: string }>;
};
type HostSession = { agent_id: number; provider: string; provider_session_id: string | null; storage_key?: string; context_id?: number; legacy_storage_session_id?: number | null; usage_epoch_id?: string | null };

/** Host authority over paths and subject mappings; the reusable coordinator never discovers files. */
export class ManagedUsageSources {
  readonly collector: HostUsageCollector;
  private readonly adapters: Record<SourceRegistration["kind"], FileUsageSource>;
  constructor(private readonly db: Database.Database, private readonly config: AppConfig) {
    this.adapters = Object.fromEntries((["codex_log", "claude_log", "context_snapshot"] as const).map((kind) => {
      const snapshot = kind === "context_snapshot";
      const reconstruct = !snapshot && !config.usageCaptureUpstreams?.[kind === "codex_log" ? "codex" : "claude_code"];
      const transcriptVersion = kind === "codex_log" ? 3 : 2;
      return [kind, new FileUsageSource({
        resolve: (input) => this.resolve(input, kind),
        parse: (text) => kind === "context_snapshot" ? parseContextSnapshot(text) : parseProviderLog(kind, text.split("\n")),
        appendOnly: kind !== "context_snapshot",
        incremental: kind === "context_snapshot" ? undefined : (state, input, signal) => {
          // A configured request relay owns attribution. Native counters still reconcile its reported totals.
          if (!reconstruct) return createProviderLogParser(kind, state);
          const profiles = this.collector.transcriptProfiles;
          const sessionId = input.providerSessionRef ?? "";
          return createTranscriptParser(kind, {
            initialModel: profiles.model(sessionId),
            measure: async (text, model) => (await this.collector.attribution.measureContent(text, "result", model, signal))!,
            profile: time => profiles.profile(sessionId, time),
            tags: profiles.skillTagger(sessionId)
          }, state);
        },
        checkpointVersion: reconstruct ? transcriptVersion : 1,
        capabilities: { usage: kind === "codex_log" ? "provider_session" : "model_request", context: snapshot || reconstruct ? "partial" : "none",
          identity: "explicit", version: snapshot ? "context-snapshot/1" : reconstruct
            ? `provider-transcript/${transcriptVersion}` : "provider-logs/1" }
      })];
    })) as Record<SourceRegistration["kind"], FileUsageSource>;
    this.collector = new HostUsageCollector(db, this.adapters, (sessionId, signal) => this.discover(sessionId, signal),
      loadModelTokenizers(config.usageTokenizers, resolve(config.dataDir, "tokenizers")), config.usageEventRetentionMs,
      config.usageDetailRetentionMs);
  }

  private async discover(sessionId: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const contexts = this.db.prepare(`SELECT c.id FROM execution_contexts c WHERE c.session_id=? AND c.provider_session_id IS NOT NULL`).all(sessionId) as Array<{ id: number }>;
    if (contexts.length) {
      for (const context of contexts) await this.discoverContext(sessionId, String(context.id), signal);
    } else await this.discoverContext(sessionId, undefined, signal);
  }

  private async discoverContext(sessionId: number, executionContextRef?: string, signal?: AbortSignal): Promise<void> {
    const session = this.session(String(sessionId), executionContextRef);
    if (!session.provider_session_id || !["codex", "claude_code"].includes(session.provider)) return;
    const nativeSessionId = session.provider_session_id;
    const providerRoot = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home");
    const kind = session.provider === "codex" ? "codex_log" : "claude_log";
    const root = kind === "codex_log" ? join(providerRoot, "codex", "sessions", session.storage_key ?? String(sessionId)) : join(providerRoot, "claude");
    const epoch = session.usage_epoch_id ?? this.collector.epoch(sessionId);
    const existing = new Set(this.collector.sources.listSources(this.collector.namespace, { sessionId: String(sessionId) })
      .map((source) => source.sourceKey));
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) throw new UsageError("usage_discovery_limit");
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (++visited > 5000) throw new UsageError("usage_discovery_limit");
        if (entry.isDirectory()) { await walk(join(directory, entry.name), depth + 1); continue; }
        if (!entry.isFile() || !(entry.name === `${nativeSessionId}.jsonl`
          || kind === "codex_log" && entry.name.endsWith(`-${nativeSessionId}.jsonl`))) continue;
        const path = relative(root, join(directory, entry.name));
        const sourceKey = `managed:${epoch}:${path}`;
        if (existing.has(sourceKey)) continue;
        await this.register({ sourceKey, kind, inputRef: { providerSessionRef: String(sessionId), ...(executionContextRef ? { executionContextRef } : {}), relativePath: path },
          mappings: [{ sourceSessionKey: nativeSessionId, sessionId: String(sessionId), providerEpochId: epoch }] }, signal);
      }
    };
    await walk(kind === "codex_log" ? join(root, "sessions") : join(root, "projects"), 0);
  }

  async register(request: SourceRegistration, signal?: AbortSignal): Promise<{ source: SourceRecord; created: boolean }> {
    signal?.throwIfAborted();
    const mappings = request.mappings.map((mapping) => {
      const sessionId = Number(mapping.sessionId);
      const session = this.session(mapping.sessionId, "providerSessionRef" in request.inputRef ? request.inputRef.executionContextRef : undefined);
      const binding = this.collector.binding(sessionId);
      this.collector.store.assertBinding(binding);
      const subject = this.db.prepare("SELECT state FROM agent_usage_subjects WHERE namespace = ? AND kind = 'session' AND subject_id = ?")
        .get(binding.namespace, binding.sessionId) as { state: string };
      if (subject.state !== "active") throw new UsageError("usage_collection_pending");
      const currentEpoch = this.collector.epoch(sessionId);
      const knownEpoch = this.db.prepare("SELECT 1 FROM agent_usage_ledger WHERE namespace = ? AND session_id = ? AND epoch_id = ? LIMIT 1")
        .get(binding.namespace, binding.sessionId, mapping.providerEpochId);
      const contextEpoch = session.usage_epoch_id;
      if (mapping.providerEpochId !== currentEpoch && mapping.providerEpochId !== contextEpoch && knownEpoch === undefined) throw new UsageError("usage_epoch_mismatch");
      if ("providerSessionRef" in request.inputRef && (request.inputRef.providerSessionRef !== mapping.sessionId
        || session.provider_session_id !== mapping.sourceSessionKey)) throw new UsageError("usage_mapping_mismatch");
      return { ...mapping, agentId: String(session.agent_id) };
    });
    const inputRef: Record<string, string> = { ...request.inputRef };
    const boundary = JSON.parse(await this.adapters[request.kind].freeze(inputRef)) as { identity: string };
    signal?.throwIfAborted();
    inputRef.fileIdentity = boundary.identity;
    const config: SourceConfig = { ...request, namespace: this.collector.namespace, mappings, inputRef };
    const existed = this.collector.sources.listSources(this.collector.namespace, { sourceKey: request.sourceKey }).length > 0;
    // Revalidate inside registration after path I/O: maintenance/deletion may have started meanwhile.
    for (const mapping of mappings) {
      this.session(mapping.sessionId);
      const binding = this.collector.binding(Number(mapping.sessionId));
      if (this.collector.sources.maintenance(binding)) throw new UsageError("usage_collection_pending");
    }
    return { source: this.collector.sources.registerSource(config), created: !existed };
  }

  private session(id: string, contextId?: string): HostSession {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new UsageError("usage_session_not_found");
    if (contextId !== undefined) {
      if (!/^[1-9]\d*$/.test(contextId) || !Number.isSafeInteger(Number(contextId))) throw new UsageError("usage_mapping_mismatch");
      const context = this.db.prepare(`SELECT s.agent_id, c.id AS context_id, c.provider, c.provider_session_id, c.legacy_storage_session_id, c.usage_epoch_id
        FROM execution_contexts c JOIN sessions s ON s.id=c.session_id WHERE c.id=? AND s.id=?`).get(Number(contextId), Number(id)) as HostSession | undefined;
      if (!context) throw new UsageError("usage_mapping_mismatch");
      return { ...context, storage_key: context.legacy_storage_session_id == null ? `context-${context.context_id}` : String(context.legacy_storage_session_id) };
    }
    const row = this.db.prepare("SELECT s.agent_id, COALESCE(c.provider_session_id,s.provider_session_id) AS provider_session_id, COALESCE(c.provider,a.provider) AS provider FROM sessions s JOIN agents a ON a.id = s.agent_id LEFT JOIN execution_contexts c ON c.id=(SELECT id FROM execution_contexts WHERE session_id=s.id AND legacy_storage_session_id IS NOT NULL ORDER BY id LIMIT 1) WHERE s.id = ?")
      .get(Number(id)) as HostSession | undefined;
    if (!row) throw new UsageError("usage_session_not_found");
    return row;
  }

  private async resolve(input: Record<string, string>, kind: SourceRegistration["kind"]): Promise<string> {
    const path = input.relativePath;
    if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new UsageError("usage_source_path_denied");
    let root: string;
    if (input.importRootId !== undefined && input.providerSessionRef === undefined) {
      const configured = this.config.usageImportRoots?.[input.importRootId];
      if (!configured) throw new UsageError("usage_source_path_denied");
      root = configured;
    } else if (input.providerSessionRef !== undefined && input.importRootId === undefined) {
      const session = this.session(input.providerSessionRef, input.executionContextRef);
      if (kind === "codex_log" && session.provider === "codex") {
        root = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home", "codex", "sessions", session.storage_key ?? input.providerSessionRef);
      } else if (kind === "claude_log" && session.provider === "claude_code" && session.provider_session_id !== null) {
        if (path.split(/[\\/]/).at(-1) !== `${session.provider_session_id}.jsonl`) throw new UsageError("usage_source_path_denied");
        root = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home", "claude");
      } else throw new UsageError("usage_source_path_denied");
    } else throw new UsageError("usage_source_path_denied");
    try {
      const [base, file] = await Promise.all([realpath(root), realpath(join(root, path))]);
      const relativePath = relative(base, file);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error();
      return file;
    } catch { throw new UsageError("usage_source_path_denied"); }
  }
}

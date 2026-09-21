import type Database from "better-sqlite3";
import {
  capabilityKinds,
  type AttributionDetail,
  type AttributionEvidence,
  type AttributionExposure,
  type AttributionFilter,
  type AttributionInvocation,
  type AttributionRankRow,
  type Capability,
  type ContextCoverage,
  type ContextEvidence,
  type ContextEvidenceDetail,
  type ExecutionEvidence,
  type InvocationInput,
  type InvocationOrigin,
  type InvocationQueryOrigin,
  type ModelContextInput,
  type RankingDimension,
  type ResultFirstUse,
  type TokenEstimate,
} from "../core/context-types.js";
import {
  capabilityKey,
  MAX_CAPABILITY_REFERENCES_PER_BLOCK,
  MAX_CONTEXT_BLOCKS,
  MAX_TOKENIZABLE_CONTEXT_BYTES,
  scopedContentKey,
  stableHash
} from "../core/context.js";
import { ModelTokenizers } from "../core/tokenizers.js";
import type { UsageBinding } from "../core/types.js";
import type { UsageStore } from "./usage-store.js";
import { ResultFirstUseIndex } from "./result-first-use.js";

const LEGACY_ESTIMATE: TokenEstimate = {
  measurement: "estimated", method: "legacy_reference", model: null, modelProvider: null,
  tokenizer: "js-tiktoken", tokenizerVersion: "1.0.21", encoding: "o200k_base",
  tokenizerId: "legacy-o200k_base", tokenizerRevision: "js-tiktoken@1.0.21/o200k_base", reason: null
};
const estimateFrom = (row: Pick<ExposureRow, "estimate_json" | "model" | "token_count">): TokenEstimate => row.estimate_json
  ? JSON.parse(row.estimate_json) as TokenEstimate
  : { ...LEGACY_ESTIMATE, model: row.model, reason: row.token_count === null ? "legacy_unavailable" : null };

type ContextRow = {
  context_id: string;
  namespace: string;
  agent_id: string;
  session_id: string;
  generation: number;
  invocation_id: string;
  provider_epoch_id: string;
  source_id: string;
  revision: number;
  occurred_at: string | null;
  runtime_kind: string | null;
  model: string | null;
  coverage: ContextCoverage;
  history_complete: number;
};

type ExposureRow = ContextRow & {
  position: number;
  block_kind: "definition" | "arguments" | "result" | "skill" | "other";
  tool_invocation_id: string | null;
  capability_key: string;
  capability_json: string;
  evidence: AttributionEvidence;
  content_key: string;
  content_identity_hash: string;
  modality: "text" | "unsupported";
  byte_length: number | null;
  token_count: number | null;
  estimate_json: string | null;
  first_use: ResultFirstUse | null;
};

type InvocationRow = {
  public_id: string;
  namespace: string;
  agent_id: string;
  session_id: string;
  generation: number;
  invocation_id: string;
  provider_epoch_id: string;
  execution_id: string | null;
  capability_key: string;
  capability_json: string;
  started_at: string | null;
  ended_at: string | null;
  status: InvocationInput["status"];
  runtime_kind: string | null;
  execution_evidence: ExecutionEvidence;
  origin: InvocationOrigin;
  source_id: string;
  revision: number;
  raw_result_bytes: number | null;
};

const nonEmpty = (value: string, code: string): void => {
  if (value.length === 0) throw new Error(code);
};
const validTime = (value: string | null, code: string): string | null => {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(code);
  return new Date(timestamp).toISOString();
};
const validRevision = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_attribution_revision");
};
const validateCapability = (capability: Capability): void => {
  nonEmpty(capability.id, "invalid_capability_id");
  nonEmpty(capability.name, "invalid_capability_name");
  if (!(capabilityKinds as readonly string[]).includes(capability.kind)) throw new Error("invalid_capability_kind");
  if (capability.serverId !== undefined) nonEmpty(capability.serverId, "invalid_capability_server");
  if (capability.version !== undefined) nonEmpty(capability.version, "invalid_capability_version");
};
const publicInvocationId = (binding: UsageBinding, epochId: string, invocationId: string): string =>
  stableHash(binding.namespace, binding.sessionId, epochId, invocationId);
const capabilityFrom = (json: string): Capability => JSON.parse(json) as Capability;
const evidenceRank = (evidence: AttributionEvidence): number => evidence === "direct" ? 3 : evidence === "matched" ? 2 : 1;

const percentiles = (samples: number[]): { p50: number | null; p95: number | null; count: number } => {
  if (samples.length === 0) return { p50: null, p95: null, count: 0 };
  const ordered = [...samples].sort((a, b) => a - b);
  const value = (percentile: number) => ordered[Math.ceil(ordered.length * percentile) - 1]!;
  return { p50: value(0.5), p95: value(0.95), count: ordered.length };
};

const coverageCounts = (): AttributionRankRow["contextCoverage"] => ({ full: 0, partial: 0, opaque: 0, none: 0 });

export type AttributionPage = { capabilityId?: string; capabilityServerId?: string; capabilityKind?: Capability["kind"];
  limit?: number; cursor?: { t: string; id: string } };

/** Persistence and queries for inspectable context attribution; raw bodies never enter SQLite. */
export class AttributionStore {
  private readonly firstUses: ResultFirstUseIndex;
  constructor(readonly store: UsageStore, private readonly tokenizers = new ModelTokenizers()) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage_contexts (
        context_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
        invocation_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL, source_id TEXT NOT NULL,
        revision INTEGER NOT NULL, occurred_at TEXT, runtime_kind TEXT, model TEXT,
        coverage TEXT NOT NULL, history_complete INTEGER NOT NULL,
        UNIQUE(namespace, session_id, provider_epoch_id, invocation_id)
      );
      CREATE TABLE IF NOT EXISTS agent_usage_exposures (
        context_id TEXT NOT NULL, position INTEGER NOT NULL, block_kind TEXT NOT NULL,
        tool_invocation_id TEXT, capability_key TEXT NOT NULL, capability_json TEXT NOT NULL,
        evidence TEXT NOT NULL, content_key TEXT NOT NULL, content_identity_hash TEXT NOT NULL,
        modality TEXT NOT NULL, byte_length INTEGER, token_count INTEGER, estimate_json TEXT,
        PRIMARY KEY(context_id, position, capability_key),
        FOREIGN KEY(context_id) REFERENCES agent_usage_contexts(context_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_usage_invocations (
        public_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
        invocation_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL, execution_id TEXT,
        capability_key TEXT NOT NULL, capability_json TEXT NOT NULL,
        started_at TEXT, ended_at TEXT, status TEXT NOT NULL, runtime_kind TEXT,
        execution_evidence TEXT NOT NULL DEFAULT 'unknown', origin TEXT NOT NULL DEFAULT 'execution', source_id TEXT NOT NULL,
        revision INTEGER NOT NULL, raw_result_bytes INTEGER,
        UNIQUE(namespace, session_id, provider_epoch_id, invocation_id)
      );
      CREATE INDEX IF NOT EXISTS agent_usage_contexts_subject
        ON agent_usage_contexts(namespace, agent_id, session_id, occurred_at);
      CREATE INDEX IF NOT EXISTS agent_usage_exposures_capability
        ON agent_usage_exposures(capability_key, block_kind);
      CREATE INDEX IF NOT EXISTS agent_usage_exposures_invocation
        ON agent_usage_exposures(tool_invocation_id);
      CREATE INDEX IF NOT EXISTS agent_usage_invocations_subject
        ON agent_usage_invocations(namespace, agent_id, session_id, started_at);
    `);
    const columns = store.db.prepare("PRAGMA table_info(agent_usage_exposures)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "estimate_json")) {
      store.db.exec("ALTER TABLE agent_usage_exposures ADD COLUMN estimate_json TEXT");
    }
    // Store tokenizer provenance once per distinct estimate profile, not once per exposure.
    store.db.transaction(() => {
      if (!columns.some((column) => column.name === "estimate_id")) store.db.exec("ALTER TABLE agent_usage_exposures ADD COLUMN estimate_id INTEGER");
      store.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_token_estimates (
        id INTEGER PRIMARY KEY, estimate_json TEXT NOT NULL UNIQUE)`);
      if (store.db.prepare("SELECT 1 FROM agent_usage_exposures WHERE estimate_id IS NULL LIMIT 1").get()) {
        store.db.prepare(`UPDATE agent_usage_exposures SET estimate_json = json_set(?,
          '$.model', (SELECT model FROM agent_usage_contexts c WHERE c.context_id = agent_usage_exposures.context_id),
          '$.reason', CASE WHEN token_count IS NULL THEN 'legacy_unavailable' ELSE NULL END)
          WHERE estimate_id IS NULL AND estimate_json IS NULL`).run(JSON.stringify(LEGACY_ESTIMATE));
        store.db.exec(`INSERT OR IGNORE INTO agent_usage_token_estimates(estimate_json)
          SELECT DISTINCT estimate_json FROM agent_usage_exposures WHERE estimate_id IS NULL;
          UPDATE agent_usage_exposures SET estimate_id=(SELECT id FROM agent_usage_token_estimates t
            WHERE t.estimate_json=agent_usage_exposures.estimate_json), estimate_json=NULL WHERE estimate_id IS NULL;`);
      }
    })();
    store.db.function("usage_context_sort_key", { deterministic: true }, (id: string) => Buffer.from(id, "hex").toString("base64url"));
    store.db.transaction(() => {
      const contextColumns = store.db.prepare("PRAGMA table_info(agent_usage_contexts)").all() as Array<{ name: string }>;
      if (!contextColumns.some((column) => column.name === "evidence_sort_key")) {
        store.db.exec("ALTER TABLE agent_usage_contexts ADD COLUMN evidence_sort_key TEXT");
        store.db.exec("UPDATE agent_usage_contexts SET evidence_sort_key=usage_context_sort_key(context_id)");
      }
      store.db.exec(`CREATE INDEX IF NOT EXISTS agent_usage_contexts_evidence_page ON agent_usage_contexts(namespace, COALESCE(occurred_at,'' ) DESC, evidence_sort_key);
        CREATE INDEX IF NOT EXISTS agent_usage_contexts_session_evidence_page ON agent_usage_contexts(namespace, session_id, COALESCE(occurred_at,'' ) DESC, evidence_sort_key);
        CREATE INDEX IF NOT EXISTS agent_usage_contexts_agent_evidence_page ON agent_usage_contexts(namespace, agent_id, COALESCE(occurred_at,'' ) DESC, evidence_sort_key);`);
    })();
    this.firstUses = new ResultFirstUseIndex(store.db);
    store.db.function("usage_evidence_id", { deterministic: true }, (contextId: string, key: string) =>
      `${Buffer.from(contextId, "hex").toString("base64url")}.${Buffer.from(stableHash(key), "hex").toString("base64url")}`);
  }

  upsertContext(binding: UsageBinding, input: ModelContextInput): void {
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      validRevision(input.revision);
      nonEmpty(input.invocationId, "invalid_context_invocation");
      nonEmpty(input.providerEpochId, "invalid_context_epoch");
      nonEmpty(input.sourceId, "invalid_context_source");
      const occurredAt = validTime(input.occurredAt, "invalid_context_time");
      const existing = this.store.db.prepare(`SELECT context_id, revision FROM agent_usage_contexts
        WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND invocation_id = ?`)
        .get(binding.namespace, binding.sessionId, input.providerEpochId, input.invocationId) as
        { context_id: string; revision: number } | undefined;
      if (existing !== undefined && input.revision <= existing.revision) return;
      const positions = new Set<number>();
      let exceededBudget = input.blocks.length > MAX_CONTEXT_BLOCKS;
      const blocks = input.blocks.slice(0, MAX_CONTEXT_BLOCKS);
      for (const block of blocks) {
        if (!Number.isSafeInteger(block.position) || block.position < 0 || positions.has(block.position)) {
          throw new Error("invalid_context_position");
        }
        positions.add(block.position);
        nonEmpty(block.content.identity, "invalid_content_identity");
        if (block.content.modality === "unsupported" && (block.content.byteLength !== undefined
          && (!Number.isSafeInteger(block.content.byteLength) || block.content.byteLength < 0))) {
          throw new Error("invalid_content_bytes");
        }
        if (block.capabilities.length > MAX_CAPABILITY_REFERENCES_PER_BLOCK) exceededBudget = true;
        for (const reference of block.capabilities.slice(0, MAX_CAPABILITY_REFERENCES_PER_BLOCK)) {
          validateCapability(reference.capability);
        }
      }

      const contextId = existing?.context_id ?? stableHash(binding.namespace, binding.sessionId, input.providerEpochId, input.invocationId);
      const coverage = input.coverage === "full" && exceededBudget ? "partial" : input.coverage;

      this.store.db.prepare(`INSERT INTO agent_usage_contexts
        (context_id, namespace, agent_id, session_id, generation, invocation_id, provider_epoch_id, source_id,
         revision, occurred_at, runtime_kind, model, coverage, history_complete, evidence_sort_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_id) DO UPDATE SET
          agent_id = excluded.agent_id, generation = excluded.generation, source_id = excluded.source_id,
          revision = excluded.revision, occurred_at = excluded.occurred_at, runtime_kind = excluded.runtime_kind,
          model = excluded.model, coverage = excluded.coverage, history_complete = excluded.history_complete
      `).run(contextId, binding.namespace, binding.agentId, binding.sessionId, binding.generation,
        input.invocationId, input.providerEpochId, input.sourceId, input.revision, occurredAt,
        input.runtimeKind, input.model, coverage, input.historyComplete ? 1 : 0, Buffer.from(contextId, "hex").toString("base64url"));
      this.store.db.prepare("DELETE FROM agent_usage_exposures WHERE context_id = ?").run(contextId);
      const insert = this.store.db.prepare(`INSERT INTO agent_usage_exposures
        (context_id, position, block_kind, tool_invocation_id, capability_key, capability_json, evidence,
         content_key, content_identity_hash, modality, byte_length, token_count, estimate_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let tokenizedBytes = 0;
      const estimateIds = new Map<string, number>();
      for (const block of blocks) {
        const references = new Map<string, typeof block.capabilities[number]>();
        for (const reference of block.capabilities.slice(0, MAX_CAPABILITY_REFERENCES_PER_BLOCK)) {
          const key = capabilityKey(reference.capability);
          const old = references.get(key);
          if (old === undefined || evidenceRank(reference.evidence) > evidenceRank(old.evidence)) references.set(key, reference);
        }
        if (references.size === 0) continue;
        const byteLength = block.content.modality === "text"
          ? Buffer.byteLength(block.content.text)
          : block.content.byteLength ?? null;
        const withinContextBudget = block.content.modality !== "text"
          || tokenizedBytes + byteLength! <= MAX_TOKENIZABLE_CONTEXT_BYTES;
        const estimate = block.content.modality !== "text"
          ? { ...this.tokenizers.describe(input.model, input.modelProvider), tokens: null, reason: "unsupported_content" as const }
          : !withinContextBudget
            ? { ...this.tokenizers.describe(input.model, input.modelProvider), tokens: null, reason: "size_limit" as const }
            : this.tokenizers.count(block.content.text, input.model, input.modelProvider);
        const { tokens: tokenCount, ...metadata } = estimate;
        const metadataJson = JSON.stringify(metadata);
        let estimateId = estimateIds.get(metadataJson);
        if (estimateId === undefined) {
          this.store.db.prepare("INSERT OR IGNORE INTO agent_usage_token_estimates(estimate_json) VALUES (?)").run(metadataJson);
          estimateId = (this.store.db.prepare("SELECT id FROM agent_usage_token_estimates WHERE estimate_json=?").get(metadataJson) as { id: number }).id;
          estimateIds.set(metadataJson, estimateId);
        }
        if (block.content.modality === "text" && references.size > 0) {
          if (estimate.reason === "size_limit") exceededBudget = true;
          if (withinContextBudget) tokenizedBytes += byteLength!;
        }
        for (const [key, reference] of references) {
          const contentKey = stableHash(scopedContentKey(block, reference.capability));
          insert.run(contextId, block.position, block.kind, block.toolInvocationId ?? null, key,
            JSON.stringify(reference.capability), reference.evidence, contentKey,
            contentKey, block.content.modality, byteLength, tokenCount, estimateId);
        }
      }
      this.firstUses.refresh(contextId);
      if (input.coverage === "full" && exceededBudget) {
        this.store.db.prepare("UPDATE agent_usage_contexts SET coverage = 'partial' WHERE context_id = ?").run(contextId);
      }
    })();
  }

  observeInvocation(binding: UsageBinding, input: InvocationInput): void {
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      validRevision(input.revision);
      nonEmpty(input.invocationId, "invalid_invocation_id");
      nonEmpty(input.providerEpochId, "invalid_invocation_epoch");
      nonEmpty(input.sourceId, "invalid_invocation_source");
      validateCapability(input.capability);
      const startedAt = validTime(input.startedAt, "invalid_invocation_start");
      const endedAt = validTime(input.endedAt, "invalid_invocation_end");
      if (input.rawResultBytes !== null && (!Number.isSafeInteger(input.rawResultBytes) || input.rawResultBytes < 0)) {
        throw new Error("invalid_invocation_result_bytes");
      }
      const id = publicInvocationId(binding, input.providerEpochId, input.invocationId);
      const executionEvidence = input.executionEvidence ?? "unknown";
      const origin = input.origin ?? "execution";
      if (!(executionEvidence === "direct" || executionEvidence === "inferred" || executionEvidence === "unknown")) {
        throw new Error("invalid_execution_evidence");
      }
      if (!(origin === "execution" || origin === "context")) throw new Error("invalid_invocation_origin");
      if (input.runtimeKind !== undefined && input.runtimeKind !== null) nonEmpty(input.runtimeKind, "invalid_invocation_runtime");
      const previous = this.store.db.prepare("SELECT revision, status, origin FROM agent_usage_invocations WHERE public_id = ?")
        .get(id) as { revision: number; status: InvocationInput["status"]; origin: InvocationOrigin } | undefined;
      if (previous !== undefined) {
        if (previous.origin === "execution" && origin === "context") return;
        const executionPromotion = previous.origin === "context" && origin === "execution";
        if (!executionPromotion && (input.revision <= previous.revision
          || (previous.status !== "running" && input.status === "running"))) return;
      }
      this.store.db.prepare(`INSERT INTO agent_usage_invocations
        (public_id, namespace, agent_id, session_id, generation, invocation_id, provider_epoch_id, execution_id,
         capability_key, capability_json, started_at, ended_at, status, runtime_kind, execution_evidence, origin,
         source_id, revision, raw_result_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(public_id) DO UPDATE SET
          agent_id = excluded.agent_id, generation = excluded.generation, execution_id = excluded.execution_id,
          capability_key = excluded.capability_key, capability_json = excluded.capability_json,
          started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status, runtime_kind = excluded.runtime_kind,
          execution_evidence = excluded.execution_evidence, origin = excluded.origin,
          source_id = excluded.source_id, revision = excluded.revision, raw_result_bytes = excluded.raw_result_bytes
      `).run(id, binding.namespace, binding.agentId, binding.sessionId, binding.generation, input.invocationId,
        input.providerEpochId, input.executionId, capabilityKey(input.capability), JSON.stringify(input.capability),
        startedAt, endedAt, input.status, input.runtimeKind ?? null, executionEvidence, origin,
        input.sourceId, input.revision, input.rawResultBytes);
    })();
  }

  rankings(filter: AttributionFilter, dimension: RankingDimension): AttributionRankRow[] {
    const { clauses, params } = this.contextWhere(filter);
    clauses.push("json_extract(e.capability_key, '$[0]') = ?"); params.push(dimension);
    const from = `FROM agent_usage_contexts c JOIN agent_usage_exposures e ON e.context_id=c.context_id
      WHERE ${clauses.join(" AND ")}`;
    const sum = (predicate: string) => `CASE WHEN SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END)=0 THEN 0
      ELSE SUM(CASE WHEN ${predicate} THEN e.token_count END) END`;
    type Aggregate = Pick<AttributionRankRow, "inputBytes" | "definitionInputTokens" | "argumentInputTokens"
      | "firstResultInputTokens" | "repeatedResultInputTokens" | "unknownFirstResultInputTokens" | "totalInputTokens"
      | "exposureCount" | "missingExposureCount"> & { capability_key: string; capability_json: string;
        direct: number; matched: number; inferred: number; full: number; partial: number; opaque: number; none: number;
        result_tokens: number | null; result_count: number; result_known: number };
    const aggregates = this.store.db.prepare(`SELECT e.capability_key, e.capability_json,
      SUM(e.byte_length) AS inputBytes, SUM(e.token_count) AS totalInputTokens,
      COUNT(*) AS exposureCount, SUM(e.token_count IS NULL) AS missingExposureCount,
      ${sum("e.block_kind='definition'")} AS definitionInputTokens,
      ${sum("e.block_kind='arguments'")} AS argumentInputTokens,
      ${sum("e.block_kind='result'")} AS result_tokens,
      SUM(e.block_kind='result') AS result_count,
      SUM(e.block_kind='result' AND e.token_count IS NOT NULL) AS result_known,
      SUM(e.evidence='direct') AS direct, SUM(e.evidence='matched') AS matched, SUM(e.evidence='inferred') AS inferred,
      COUNT(DISTINCT CASE WHEN c.coverage='full' THEN c.context_id END) AS full,
      COUNT(DISTINCT CASE WHEN c.coverage='partial' THEN c.context_id END) AS partial,
      COUNT(DISTINCT CASE WHEN c.coverage='opaque' THEN c.context_id END) AS opaque,
      COUNT(DISTINCT CASE WHEN c.coverage='none' THEN c.context_id END) AS none
      ${from} GROUP BY e.capability_key`).all(...params) as Aggregate[];
    // First-use identities are indexed separately: repeated history needs no per-row index lookup.
    const firstGroups = this.store.db.prepare(`SELECT e.capability_key, c.history_complete,
      COUNT(*) AS count, COUNT(e.token_count) AS known, SUM(e.token_count) AS tokens
      FROM agent_usage_result_first f JOIN agent_usage_contexts c ON c.context_id=f.context_id
        AND c.namespace=f.namespace AND c.session_id=f.session_id AND c.provider_epoch_id=f.provider_epoch_id
      JOIN agent_usage_exposures e ON e.context_id=f.context_id AND e.position=f.position AND e.capability_key=f.capability_key
      WHERE f.runtime_scope=? AND ${clauses.join(" AND ")} GROUP BY e.capability_key, c.history_complete`)
      .all(filter.runtimeKind === undefined ? "" : JSON.stringify(filter.runtimeKind), ...params) as Array<{
        capability_key: string; history_complete: number; count: number; known: number; tokens: number | null }>;
    const firstByKey = new Map<string, typeof firstGroups>();
    for (const item of firstGroups) {
      const group = firstByKey.get(item.capability_key) ?? []; group.push(item); firstByKey.set(item.capability_key, group);
    }
    const groups = new Map<string, AttributionRankRow>();
    const empty = (capability: Capability): AttributionRankRow => ({
      measurement: "estimated", tokenizationStatus: "unavailable", tokenEstimates: [], capability,
      inputBytes: null, calls: 0, contextOnlyCalls: 0, successes: 0, failures: 0, unfinished: 0,
      definitionInputTokens: null, argumentInputTokens: null, firstResultInputTokens: null,
      repeatedResultInputTokens: null, unknownFirstResultInputTokens: null, totalInputTokens: null,
      exposureCount: 0, missingExposureCount: 0, estimateCompleteness: "none",
      attributionEvidence: { direct: 0, matched: 0, inferred: 0 }, contextCoverage: coverageCounts(),
      rawResultBytes: null, rawResultBytesP50: null, rawResultBytesP95: null, rawResultBytesSampleCount: 0,
      latencyMsP50: null, latencyMsP95: null, latencySampleCount: 0
    });
    for (const aggregate of aggregates) {
      const { capability_key, capability_json, direct, matched, inferred, full, partial, opaque, none,
        result_tokens, result_count, result_known, ...values } = aggregate;
      const first = firstByKey.get(capability_key) ?? [];
      const firstKnown = first.reduce((sum, row) => sum + row.known, 0);
      const repeatCount = result_count - first.reduce((sum, row) => sum + row.count, 0);
      const repeatTokens = repeatCount === 0 ? 0 : result_known === firstKnown ? null
        : (result_tokens ?? 0) - first.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
      // Only one representative row per capability, preserving the latest display metadata.
      const latest = this.store.db.prepare(`SELECT e.capability_json FROM agent_usage_contexts c
        CROSS JOIN agent_usage_exposures e INDEXED BY sqlite_autoindex_agent_usage_exposures_1 ON e.context_id=c.context_id
        WHERE ${clauses.join(" AND ")} AND e.capability_key=?
        ORDER BY c.occurred_at IS NULL DESC, c.occurred_at DESC, c.context_id DESC, e.position DESC LIMIT 1`)
        .get(...params, capability_key) as { capability_json: string };
      groups.set(capability_key, { ...empty(capabilityFrom(latest?.capability_json ?? capability_json)), ...values,
        firstResultInputTokens: first.find((row) => row.history_complete === 1)?.tokens ?? (first.some((row) => row.history_complete === 1) ? null : 0),
        unknownFirstResultInputTokens: first.find((row) => row.history_complete === 0)?.tokens ?? (first.some((row) => row.history_complete === 0) ? null : 0),
        repeatedResultInputTokens: repeatTokens,
        estimateCompleteness: values.missingExposureCount === values.exposureCount ? "none"
          : values.missingExposureCount > 0 ? "partial" : "complete",
        attributionEvidence: { direct, matched, inferred }, contextCoverage: { full, partial, opaque, none } });
    }
    const estimates = this.store.db.prepare(`SELECT e.capability_key, t.estimate_json, c.model,
      COUNT(*) AS exposureCount, COUNT(e.token_count) AS knownExposureCount, SUM(e.token_count) AS totalInputTokens
      FROM agent_usage_contexts c JOIN agent_usage_exposures e ON e.context_id=c.context_id
      JOIN agent_usage_token_estimates t ON t.id=e.estimate_id
      WHERE ${clauses.join(" AND ")} GROUP BY e.capability_key, e.estimate_id`)
      .all(...params) as Array<{ capability_key: string; estimate_json: string | null; model: string | null;
        exposureCount: number; knownExposureCount: number; totalInputTokens: number | null }>;
    for (const item of estimates) {
      const row = groups.get(item.capability_key)!;
      row.tokenEstimates.push({ ...estimateFrom({ ...item, token_count: item.totalInputTokens }),
        exposureCount: item.exposureCount, knownExposureCount: item.knownExposureCount, totalInputTokens: item.totalInputTokens });
    }
    const samples = new Map<string, { bytes: number[]; latencies: number[] }>();
    for (const origin of ["execution", "context"] as const) {
      for (const call of this.invocationRows(filter, origin, { capabilityKind: dimension })) {
        const row = groups.get(call.capability_key) ?? empty(capabilityFrom(call.capability_json));
        groups.set(call.capability_key, row);
        if (origin === "context") { row.contextOnlyCalls++; continue; }
        row.calls++;
        if (call.status === "running") row.unfinished++;
        else if (call.status === "succeeded") row.successes++;
        else row.failures++;
        const sample = samples.get(call.capability_key) ?? { bytes: [], latencies: [] };
        samples.set(call.capability_key, sample);
        if (call.raw_result_bytes !== null) sample.bytes.push(call.raw_result_bytes);
        if (call.started_at !== null && call.ended_at !== null) {
          const elapsed = Date.parse(call.ended_at) - Date.parse(call.started_at);
          if (elapsed >= 0) sample.latencies.push(elapsed);
        }
      }
    }
    for (const [key, row] of groups) {
      const known = row.tokenEstimates.filter((item) => item.knownExposureCount > 0).length;
      row.tokenizationStatus = known > 1 ? "mixed" : known === 1 ? "single" : "unavailable";
      const sample = samples.get(key);
      if (!sample) continue;
      const bytes = percentiles(sample.bytes), latency = percentiles(sample.latencies);
      row.rawResultBytes = sample.bytes.length ? sample.bytes.reduce((sum, value) => sum + value, 0) : null;
      row.rawResultBytesP50 = bytes.p50; row.rawResultBytesP95 = bytes.p95; row.rawResultBytesSampleCount = bytes.count;
      row.latencyMsP50 = latency.p50; row.latencyMsP95 = latency.p95; row.latencySampleCount = latency.count;
    }
    return [...groups.values()].sort((a, b) => (b.totalInputTokens ?? -1) - (a.totalInputTokens ?? -1)
      || b.calls - a.calls || a.capability.name.localeCompare(b.capability.name));
  }

  invocations(filter: AttributionFilter = {}, origin: InvocationQueryOrigin = "counted", options: AttributionPage = {}): AttributionInvocation[] {
    return this.invocationRows(filter, origin === "counted" ? "execution" : origin, options).map((row) => this.toInvocation(row));
  }

  invocation(namespace: string, id: string): AttributionInvocation | null {
    const row = this.store.db.prepare("SELECT * FROM agent_usage_invocations WHERE namespace = ? AND public_id = ?")
      .get(namespace, id) as InvocationRow | undefined;
    return row ? this.toInvocation(row) : null;
  }

  detail(namespace: string, id: string): AttributionDetail | null {
    const row = this.store.db.prepare("SELECT * FROM agent_usage_invocations WHERE namespace = ? AND public_id = ?")
      .get(namespace, id) as InvocationRow | undefined;
    if (row === undefined) return null;
    const capability = capabilityFrom(row.capability_json);
    const all = this.exposureRows({ namespace, sessionId: row.session_id },
      ["c.provider_epoch_id=?", "e.tool_invocation_id=?", "e.capability_key=?"],
      [row.provider_epoch_id, row.invocation_id, row.capability_key]);
    const exposures: AttributionExposure[] = all.map((exposure) => ({
      ...estimateFrom(exposure), modelInvocationId: exposure.invocation_id,
      providerEpochId: exposure.provider_epoch_id, occurredAt: exposure.occurred_at,
      position: exposure.position, kind: exposure.block_kind, evidence: exposure.evidence,
      coverage: exposure.coverage, contentIdentityHash: exposure.content_identity_hash,
      modality: exposure.modality, byteLength: exposure.byte_length, tokens: exposure.token_count,
      resultFirstUse: exposure.first_use
    }));
    return {
      invocation: { ...this.toInvocation(row), capability },
      exposures,
      subsequentModelInvocationIds: [...new Set(exposures.map((exposure) => exposure.modelInvocationId))]
    };
  }

  contextEvidence(filter: AttributionFilter = {}, options: AttributionPage = {}): ContextEvidence[] {
    const scope = this.contextWhere(filter);
    const capability: string[] = [], values: string[] = [];
    this.capabilityWhere(capability, values, "e", options);
    if (options.cursor) {
      // The first 43 characters are the context part of the existing opaque evidence ID.
      scope.clauses.push("COALESCE(c.occurred_at,'') <= ?",
        "(COALESCE(c.occurred_at,'') < ? OR c.evidence_sort_key >= ?)");
      scope.params.push(options.cursor.t, options.cursor.t, options.cursor.id.slice(0, 43));
      capability.push("(COALESCE(c.occurred_at,'') < ? OR usage_evidence_id(c.context_id,e.capability_key) > ?)");
      values.push(options.cursor.t, options.cursor.id);
    }
    // Every candidate contributes at least one matching evidence row; N contexts suffice for N rows.
    // The persistent context sort key lets SQLite stop before grouping/hashing historical exposures.
    const rows = this.store.db.prepare(`WITH candidates AS MATERIALIZED (
      SELECT c.* FROM agent_usage_contexts c WHERE ${[...scope.clauses,
        `EXISTS (SELECT 1 FROM agent_usage_exposures e WHERE e.context_id=c.context_id${capability.length ? ` AND ${capability.join(" AND ")}` : ""})`].join(" AND ")}
      ORDER BY COALESCE(c.occurred_at,'') DESC, c.evidence_sort_key
      ${options.limit === undefined ? "" : "LIMIT ?"})
      SELECT c.*, e.capability_key, e.capability_json, COUNT(*) AS exposure_count
      FROM candidates c JOIN agent_usage_exposures e ON e.context_id=c.context_id
      ${capability.length ? `WHERE ${capability.join(" AND ")}` : ""}
      GROUP BY c.context_id, e.capability_key
      ORDER BY COALESCE(c.occurred_at,'') DESC, usage_evidence_id(c.context_id,e.capability_key)
      ${options.limit === undefined ? "" : "LIMIT ?"}`)
      .all(...scope.params, ...values, ...(options.limit === undefined ? [] : [options.limit]),
        ...values, ...(options.limit === undefined ? [] : [options.limit])) as Array<ExposureRow & { exposure_count: number }>;
    return rows.map((row) => ({ ...this.toContextEvidence(row), exposureCount: row.exposure_count }));
  }

  contextEvidenceDetail(namespace: string, id: string): ContextEvidenceDetail | null {
    if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const [contextId, capabilityHash] = id.split(".").map((part) => Buffer.from(part, "base64url").toString("hex"));
    const context = this.store.db.prepare("SELECT * FROM agent_usage_contexts WHERE namespace = ? AND context_id = ?")
      .get(namespace, contextId) as ContextRow | undefined;
    if (!context) return null;
    const candidates = this.store.db.prepare("SELECT DISTINCT capability_key FROM agent_usage_exposures WHERE context_id=?")
      .all(contextId) as Array<{ capability_key: string }>;
    const key = candidates.find((row) => stableHash(row.capability_key) === capabilityHash)?.capability_key;
    if (!key) return null;
    const selected = this.exposureRows({ namespace }, ["c.context_id=?", "e.capability_key=?"], [contextId!, key]);
    if (!selected.length) return null;
    return { context: { ...this.toContextEvidence(selected[0]!), exposureCount: selected.length },
      exposures: selected.map((row) => ({ ...estimateFrom(row),
        modelInvocationId: row.invocation_id, toolInvocationId: row.tool_invocation_id,
        providerEpochId: row.provider_epoch_id, occurredAt: row.occurred_at, position: row.position,
        kind: row.block_kind, evidence: row.evidence, coverage: row.coverage,
        contentIdentityHash: row.content_identity_hash, modality: row.modality,
        byteLength: row.byte_length, tokens: row.token_count, resultFirstUse: row.first_use })) };
  }

  private toContextEvidence(row: ExposureRow): ContextEvidence {
    return { id: `${Buffer.from(row.context_id, "hex").toString("base64url")}.${Buffer.from(stableHash(row.capability_key), "hex").toString("base64url")}`, namespace: row.namespace,
      agentId: row.agent_id, sessionId: row.session_id, providerEpochId: row.provider_epoch_id,
      modelInvocationId: row.invocation_id, occurredAt: row.occurred_at, runtimeKind: row.runtime_kind,
      model: row.model, capability: capabilityFrom(row.capability_json), exposureCount: 1 };
  }

  deleteSession(namespace: string, sessionId: string): void {
    this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM agent_usage_result_first WHERE namespace=? AND session_id=?").run(namespace, sessionId);
      this.store.db.prepare(`DELETE FROM agent_usage_exposures WHERE context_id IN
        (SELECT context_id FROM agent_usage_contexts WHERE namespace = ? AND session_id = ?)`)
        .run(namespace, sessionId);
      this.store.db.prepare("DELETE FROM agent_usage_contexts WHERE namespace = ? AND session_id = ?").run(namespace, sessionId);
      this.store.db.prepare("DELETE FROM agent_usage_invocations WHERE namespace = ? AND session_id = ?").run(namespace, sessionId);
    })();
  }

  private capabilityWhere(clauses: string[], params: string[], alias: string, options: AttributionPage): void {
    for (const [field, index] of [["capabilityKind", 0], ["capabilityServerId", 1], ["capabilityId", 2]] as const) {
      if (options[field] !== undefined) { clauses.push(`json_extract(${alias}.capability_key, '$[${index}]') = ?`); params.push(options[field]); }
    }
  }

  private invocationRows(filter: AttributionFilter, origin: InvocationOrigin, options: AttributionPage = {}): InvocationRow[] {
    const clauses = ["i.origin=?"], params: string[] = [origin];
    for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"], ["runtimeKind", "runtime_kind"]] as const) {
      if (filter[field] !== undefined) { clauses.push(`i.${column}=?`); params.push(filter[field]); }
    }
    this.capabilityWhere(clauses, params, "i", options);
    if (origin === "context" && (filter.from !== undefined || filter.to !== undefined)) {
      const context = this.contextWhere({ from: filter.from, to: filter.to });
      clauses.push(`EXISTS (SELECT 1 FROM agent_usage_exposures e JOIN agent_usage_contexts c ON c.context_id=e.context_id
        WHERE e.tool_invocation_id=i.invocation_id AND e.capability_key=i.capability_key
          AND c.namespace=i.namespace AND c.session_id=i.session_id AND c.provider_epoch_id=i.provider_epoch_id
          AND ${context.clauses.join(" AND ")})`);
      params.push(...context.params);
    } else {
      if (filter.from !== undefined) { clauses.push("i.started_at>=?"); params.push(new Date(filter.from).toISOString()); }
      if (filter.to !== undefined) { clauses.push("i.started_at<?"); params.push(new Date(filter.to).toISOString()); }
    }
    if (options.cursor) {
      clauses.push("(COALESCE(i.started_at,'') < ? OR (COALESCE(i.started_at,'') = ? AND i.public_id > ?))");
      params.push(options.cursor.t, options.cursor.t, options.cursor.id);
    }
    return this.store.db.prepare(`SELECT i.* FROM agent_usage_invocations i WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(i.started_at,'') DESC, i.public_id ${options.limit === undefined ? "" : "LIMIT ?"}`)
      .all(...params, ...(options.limit === undefined ? [] : [options.limit])) as InvocationRow[];
  }

  private contextWhere(filter: AttributionFilter): { clauses: string[]; params: string[] } {
    const clauses: string[] = [], params: string[] = [];
    for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"], ["runtimeKind", "runtime_kind"]] as const) {
      if (filter[field] !== undefined) { clauses.push(`c.${column}=?`); params.push(filter[field]); }
    }
    if (filter.from !== undefined) { clauses.push("c.occurred_at>=?"); params.push(new Date(filter.from).toISOString()); }
    if (filter.to !== undefined) { clauses.push("c.occurred_at<?"); params.push(new Date(filter.to).toISOString()); }
    return { clauses, params };
  }

  private exposureRows(filter: AttributionFilter, extra: string[] = [], values: string[] = []): ExposureRow[] {
    const { clauses, params } = this.contextWhere(filter);
    clauses.push(...extra); params.push(...values);
    return this.store.db.prepare(`SELECT c.*, e.*, t.estimate_json, ${ResultFirstUseIndex.classification} AS first_use
      FROM agent_usage_contexts c JOIN agent_usage_exposures e ON e.context_id=c.context_id
      JOIN agent_usage_token_estimates t ON t.id=e.estimate_id ${ResultFirstUseIndex.join}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY c.occurred_at IS NULL, c.occurred_at, c.context_id, e.position, e.capability_key`)
      .all(filter.runtimeKind === undefined ? "" : JSON.stringify(filter.runtimeKind), ...params) as ExposureRow[];
  }

  private toInvocation(row: InvocationRow): AttributionInvocation {
    return {
      id: row.public_id,
      namespace: row.namespace,
      agentId: row.agent_id,
      sessionId: row.session_id,
      generation: row.generation,
      invocationId: row.invocation_id,
      providerEpochId: row.provider_epoch_id,
      executionId: row.execution_id,
      capability: capabilityFrom(row.capability_json),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      runtimeKind: row.runtime_kind,
      executionEvidence: row.execution_evidence,
      origin: row.origin,
      sourceId: row.source_id,
      revision: row.revision,
      rawResultBytes: row.raw_result_bytes
    };
  }

}

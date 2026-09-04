import type Database from "better-sqlite3";

import type { AgentCoreProfile, SessionCoreBinding, TokenUsageTotals } from "../domain.js";

type BindingRow = {
  id: number;
  session_id: number;
  core_profile_id: number;
  provider_session_id: string | null;
  context_cursor_run_id: number | null;
  last_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
  last_used_at: string | null;
  storage_cleaned_at: string | null;
  created_at: string;
  updated_at: string;
};

const toBinding = (row: BindingRow): SessionCoreBinding => ({
  id: row.id,
  sessionId: row.session_id,
  coreProfileId: row.core_profile_id,
  providerSessionId: row.provider_session_id,
  contextCursorRunId: row.context_cursor_run_id,
  lastModel: row.last_model,
  usage: [
    row.input_tokens,
    row.output_tokens,
    row.cached_read_tokens,
    row.cached_write_tokens,
    row.thought_tokens,
    row.total_tokens
  ].every((value) => value === null) ? null : {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedReadTokens: row.cached_read_tokens,
    cachedWriteTokens: row.cached_write_tokens,
    thoughtTokens: row.thought_tokens,
    totalTokens: row.total_tokens
  },
  lastUsedAt: row.last_used_at,
  storageCleanedAt: row.storage_cleaned_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/** Persists one Provider conversation per business Session and Core identity. */
export class SessionCoreBindingStore {
  constructor(private readonly db: Database.Database) {}

  list(sessionId: number): SessionCoreBinding[] {
    return (this.db.prepare(`
      SELECT * FROM session_core_bindings WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(sessionId) as BindingRow[]).map(toBinding);
  }

  getOrCreate(sessionId: number, profile: AgentCoreProfile): SessionCoreBinding {
    const existing = this.find(sessionId, profile.id);
    if (existing !== undefined) return existing;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_core_bindings
        (session_id, core_profile_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, core_profile_id) DO NOTHING
    `).run(sessionId, profile.id, now, now);
    return this.find(sessionId, profile.id)!;
  }

  saveProviderSession(id: number, providerSessionId: string | null, model: string | null): SessionCoreBinding {
    const now = new Date().toISOString();
    const updated = this.db.prepare(`
      UPDATE session_core_bindings
      SET provider_session_id = ?, last_model = ?, last_used_at = ?, updated_at = ?
      WHERE id = ?
    `).run(providerSessionId, model, now, now, id);
    if (updated.changes !== 1) throw new Error("session_core_binding_not_found");
    return this.get(id)!;
  }

  saveUsage(id: number, usage: Partial<TokenUsageTotals>): SessionCoreBinding {
    const now = new Date().toISOString();
    const updated = this.db.prepare(`
      UPDATE session_core_bindings SET
        input_tokens = ?, output_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?,
        thought_tokens = ?, total_tokens = ?, last_used_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.cachedReadTokens ?? null,
      usage.cachedWriteTokens ?? null,
      usage.thoughtTokens ?? null,
      usage.totalTokens ?? null,
      now,
      now,
      id
    );
    if (updated.changes !== 1) throw new Error("session_core_binding_not_found");
    const binding = this.get(id)!;
    this.refreshSessionUsage(binding.sessionId, now);
    return binding;
  }

  advanceCursor(id: number, runId: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE session_core_bindings
      SET context_cursor_run_id = CASE
        WHEN context_cursor_run_id IS NULL OR context_cursor_run_id < ? THEN ?
        ELSE context_cursor_run_id
      END, last_used_at = ?, updated_at = ?
      WHERE id = ?
    `).run(runId, runId, now, now, id);
  }

  clearProviderSessions(sessionId: number, cleanedAt: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE session_core_bindings
      SET provider_session_id = NULL, context_cursor_run_id = NULL, last_model = NULL,
        storage_cleaned_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(cleanedAt, now, sessionId);
  }

  get(id: number): SessionCoreBinding | undefined {
    const row = this.db.prepare("SELECT * FROM session_core_bindings WHERE id = ?").get(id) as BindingRow | undefined;
    return row === undefined ? undefined : toBinding(row);
  }

  private find(sessionId: number, coreProfileId: number): SessionCoreBinding | undefined {
    const row = this.db.prepare(`
      SELECT * FROM session_core_bindings
      WHERE session_id = ? AND core_profile_id = ?
    `).get(sessionId, coreProfileId) as BindingRow | undefined;
    return row === undefined ? undefined : toBinding(row);
  }

  private refreshSessionUsage(sessionId: number, updatedAt: string): void {
    const totals = this.db.prepare(`
      SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cached_read_tokens) AS cached_read_tokens, SUM(cached_write_tokens) AS cached_write_tokens,
        SUM(thought_tokens) AS thought_tokens, SUM(total_tokens) AS total_tokens
      FROM session_core_bindings WHERE session_id = ?
    `).get(sessionId) as {
      input_tokens: number | null;
      output_tokens: number | null;
      cached_read_tokens: number | null;
      cached_write_tokens: number | null;
      thought_tokens: number | null;
      total_tokens: number | null;
    };
    this.db.prepare(`
      UPDATE sessions SET input_tokens = ?, output_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?,
        thought_tokens = ?, total_tokens = ?, updated_at = ? WHERE id = ?
    `).run(
      totals.input_tokens,
      totals.output_tokens,
      totals.cached_read_tokens,
      totals.cached_write_tokens,
      totals.thought_tokens,
      totals.total_tokens,
      updatedAt,
      sessionId
    );
  }
}

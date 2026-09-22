import type { TokenEstimate } from "./core/context-types.js";
import type { UsageStore } from "./storage/usage-store.js";
import type { AttributionStore } from "./storage/attribution-store.js";

export type ConversationCategory = "user_prompt" | "configured_instructions" | "assistant_output" | "assistant_thought";

/** Counts retained runtime content once at its observed boundary, without inventing model-request replay. */
export class RuntimeConversationCollector {
  constructor(private readonly store: UsageStore, private readonly attribution: AttributionStore, private readonly namespace: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_conversation_content (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, run_id INTEGER NOT NULL,
      event_key TEXT NOT NULL, category TEXT NOT NULL, occurred_at TEXT NOT NULL, runtime_kind TEXT NOT NULL,
      tokens INTEGER, bytes INTEGER NOT NULL, partial INTEGER NOT NULL, estimate_json TEXT NOT NULL,
      PRIMARY KEY(namespace,run_id,event_key,category)
    ); CREATE INDEX IF NOT EXISTS agent_usage_conversation_scope
      ON agent_usage_conversation_content(namespace,agent_id,session_id,occurred_at);
    CREATE INDEX IF NOT EXISTS agent_usage_conversation_page
      ON agent_usage_conversation_content(namespace,occurred_at DESC,run_id DESC,event_key,category);
    CREATE INDEX IF NOT EXISTS agent_usage_conversation_session_page
      ON agent_usage_conversation_content(namespace,session_id,occurred_at DESC,run_id DESC,event_key,category)`);
  }

  recordRun(runId: number): void {
    const row = this.store.db.prepare(`SELECT r.input,s.instructions_snapshot FROM runs r
      JOIN sessions s ON s.id=r.session_id WHERE r.id=?`).get(runId) as { input: string; instructions_snapshot: string } | undefined;
    if (!row) return;
    this.record(runId, "run", "user_prompt", row.input);
    if (row.instructions_snapshot) this.record(runId, "run", "configured_instructions", row.instructions_snapshot);
  }

  recordMessage(runId: number, content: Record<string, unknown>, event: { sequence: number; occurredAt: string }): void {
    if (typeof content.text !== "string" || !["output", "thought"].includes(String(content.stream))) return;
    this.record(runId, String(event.sequence), content.stream === "thought" ? "assistant_thought" : "assistant_output", content.text, event.occurredAt);
  }

  deleteSession(sessionId: string): void {
    this.store.db.prepare("DELETE FROM agent_usage_conversation_content WHERE namespace=? AND session_id=?").run(this.namespace, sessionId);
  }

  private record(runId: number, key: string, category: ConversationCategory, text: string, occurredAt?: string): void {
    if (this.store.db.prepare(`SELECT 1 FROM agent_usage_conversation_content
      WHERE namespace=? AND run_id=? AND event_key=? AND category=?`).get(this.namespace, runId, key, category)) return;
    const row = this.store.db.prepare(`SELECT s.id AS session_id,s.agent_id,a.provider,r.resolved_model,
      COALESCE(r.started_at,r.created_at) AS occurred_at FROM runs r JOIN sessions s ON s.id=r.session_id
      JOIN agents a ON a.id=s.agent_id WHERE r.id=?`).get(runId) as {
      session_id: number; agent_id: number; provider: string; resolved_model: string | null; occurred_at: string
    } | undefined;
    if (!row) return;
    const binding = this.store.bindSession(this.namespace, String(row.agent_id), String(row.session_id));
    this.store.assertBinding(binding);
    const measured = this.attribution.measureContent(text, "result", row.resolved_model);
    if (!measured) return;
    const estimate: TokenEstimate = measured.estimate;
    this.store.db.prepare(`INSERT OR IGNORE INTO agent_usage_conversation_content
      (namespace,session_id,agent_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.namespace,binding.sessionId,binding.agentId,runId,key,category,
        occurredAt ?? row.occurred_at,row.provider,measured.tokens,measured.byteLength,Number(measured.partial),JSON.stringify(estimate));
  }
}

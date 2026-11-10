import type Database from "better-sqlite3";
import { HostUsageCollector } from "../agent-usage/host-collector.js";

import type { Provider } from "../domain.js";
import type { ProviderSessionCleaner } from "../runtime/provider-session-cleaner.js";
import { executionContextStorageKey } from "../runtime/execution-context-storage.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";

export type SessionMaintenanceOperation = "cleanup" | "delete" | "reset";

type MaintenanceRow = {
  id: number;
  agent_id: number;
  provider: Provider;
  provider_session_id: string | null;
};

type ContextRow = { id: number; provider: Provider; provider_session_id: string | null; legacy_storage_session_id: number | null; retired_at: string | null };

type MaintenanceDependencies = {
  db: Database.Database;
  workspaceManager: Pick<WorkspaceManager, "deleteSession">;
  providerSessionCleaner: ProviderSessionCleaner;
  usageCollector?: HostUsageCollector;
};

const requireClaim = (db: Database.Database, id: number, operation: SessionMaintenanceOperation): MaintenanceRow => {
  const row = db.prepare(`
    SELECT session.id, session.agent_id, agent.provider, session.provider_session_id
    FROM sessions session JOIN agents agent ON agent.id = session.agent_id
    WHERE session.id = ? AND session.status = 'running' AND session.pending_operation = ?
      AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id = session.id AND status IN ('queued', 'running'))
  `).get(id, operation) as MaintenanceRow | undefined;
  if (row === undefined) throw new Error("session_maintenance_claim_lost");
  return row;
};

/** Commits only the terminal state of the operation that still owns this Session. */
export const finishSessionMaintenance = (
  db: Database.Database,
  id: number,
  operation: SessionMaintenanceOperation,
  completedAt = new Date().toISOString(),
  usageCollector = new HostUsageCollector(db)
): void => {
  db.transaction(() => {
    requireClaim(db, id, operation);
    if (operation === "delete" || operation === "cleanup") {
      db.prepare("DELETE FROM webhook_deliveries WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)").run(id);
    }
    if (operation === "delete") {
      usageCollector.deleteSession(id);
      db.prepare("DELETE FROM integration_task_events WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)").run(id);
      db.prepare("DELETE FROM integration_tasks WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM integration_conversations WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(id);
      db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    } else if (operation === "cleanup") {
      usageCollector.finishMaintenance(id);
      db.prepare("UPDATE message_attachments SET data = NULL WHERE session_id = ?").run(id);
      db.prepare(`
        UPDATE sessions SET status = 'idle', pending_operation = NULL,
          provider_session_id = NULL, storage_cleaned_at = ? WHERE id = ?
      `).run(completedAt, id);
    } else {
      usageCollector.finishMaintenance(id);
      db.prepare("UPDATE execution_contexts SET retired_at = ? WHERE session_id = ? AND retired_at IS NULL")
        .run(completedAt, id);
      db.prepare(`
        UPDATE sessions SET status = 'idle', pending_operation = NULL, provider_session_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(completedAt, id);
    }
  }).immediate();
};

/** Repeats idempotent storage removal before committing a durable maintenance operation. */
export const completeSessionMaintenance = async (
  dependencies: MaintenanceDependencies,
  id: number,
  operation: SessionMaintenanceOperation,
  completedAt = new Date().toISOString()
): Promise<void> => {
  const row = requireClaim(dependencies.db, id, operation);
  const usageCollector = dependencies.usageCollector ?? new HostUsageCollector(dependencies.db);
  if (operation === "delete") usageCollector.deleteSession(id);
  else {
    await usageCollector.prepareMaintenance(id, operation);
  }
  const contexts = dependencies.db.prepare(`
    SELECT id, provider, provider_session_id, legacy_storage_session_id, retired_at FROM execution_contexts
    WHERE session_id = ?
  `).all(id) as ContextRow[];
  // Only Sessions with no context history use legacy storage. Repeated reset must
  // not fall back to a retired context’s legacy Session key.
  const targets = contexts.length === 0
    ? [{ id, provider: row.provider, provider_session_id: row.provider_session_id, legacy_storage_session_id: id }]
    : contexts.filter(context => operation !== "reset" || context.retired_at === null);
  for (const context of targets) {
    await dependencies.providerSessionCleaner.purge({
      agentId: row.agent_id,
      provider: context.provider,
      sessionId: id,
      providerSessionId: context.provider_session_id,
      ...(contexts.length === 0 ? {} : { storageKey: context.legacy_storage_session_id === null
        ? executionContextStorageKey(context.id)
        : String(context.legacy_storage_session_id) })
    });
  }
  if (operation !== "reset") await dependencies.workspaceManager.deleteSession(id);
  finishSessionMaintenance(dependencies.db, id, operation, completedAt, usageCollector);
};

/** Runs before any scheduling; failed operations keep their durable claim for a later retry. */
export const recoverSessionMaintenance = async (
  dependencies: MaintenanceDependencies,
  onError: (id: number, operation: SessionMaintenanceOperation) => void = (id, operation) => {
    console.error(`session_maintenance_recovery_failed sessionId=${id} operation=${operation}`);
  }
): Promise<void> => {
  const pending = dependencies.db.prepare(`
    SELECT id, pending_operation FROM sessions WHERE pending_operation IS NOT NULL ORDER BY id
  `).all() as Array<{ id: number; pending_operation: SessionMaintenanceOperation }>;
  for (const { id, pending_operation: operation } of pending) {
    try {
      await completeSessionMaintenance(dependencies, id, operation);
    } catch (_error) {
      onError(id, operation);
    }
  }
};

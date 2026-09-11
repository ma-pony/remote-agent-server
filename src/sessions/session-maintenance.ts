import type Database from "better-sqlite3";

import type { Provider } from "../domain.js";
import type { ProviderSessionCleaner } from "../runtime/provider-session-cleaner.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";

export type SessionMaintenanceOperation = "cleanup" | "delete" | "reset";

type MaintenanceRow = {
  id: number;
  agent_id: number;
  provider: Provider;
  provider_session_id: string | null;
};

type MaintenanceDependencies = {
  db: Database.Database;
  workspaceManager: Pick<WorkspaceManager, "deleteSession">;
  providerSessionCleaner: ProviderSessionCleaner;
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
  completedAt = new Date().toISOString()
): void => {
  db.transaction(() => {
    requireClaim(db, id, operation);
    if (operation === "delete") {
      db.prepare("DELETE FROM webhook_deliveries WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)").run(id);
      db.prepare("DELETE FROM integration_task_events WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)").run(id);
      db.prepare("DELETE FROM integration_tasks WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM integration_conversations WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(id);
      db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    } else if (operation === "cleanup") {
      db.prepare(`
        UPDATE sessions SET status = 'idle', pending_operation = NULL,
          provider_session_id = NULL, storage_cleaned_at = ? WHERE id = ?
      `).run(completedAt, id);
    } else {
      db.prepare(`
        UPDATE sessions SET status = 'idle', pending_operation = NULL, provider_session_id = NULL,
          input_tokens = NULL, output_tokens = NULL, cached_read_tokens = NULL,
          cached_write_tokens = NULL, thought_tokens = NULL, total_tokens = NULL, updated_at = ?
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
  await dependencies.providerSessionCleaner.purge({
    agentId: row.agent_id,
    provider: row.provider,
    sessionId: id,
    providerSessionId: row.provider_session_id
  });
  if (operation !== "reset") await dependencies.workspaceManager.deleteSession(id);
  finishSessionMaintenance(dependencies.db, id, operation, completedAt);
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

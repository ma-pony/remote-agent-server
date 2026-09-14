import { access, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Provider } from "../domain.js";

export type ProviderSessionStorage = {
  agentId: number;
  provider: Provider;
  sessionId: number;
  providerSessionId: string | null;
};

export interface ProviderSessionCleaner {
  purge(input: ProviderSessionStorage): Promise<void>;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Removes one Provider's durable conversation files without touching shared credentials and configuration. */
export class SystemProviderSessionCleaner implements ProviderSessionCleaner {
  constructor(private readonly dataDir: string) {}

  async purge(input: ProviderSessionStorage): Promise<void> {
    const acpxKey = encodeURIComponent(`remote-agent:${input.sessionId}`);
    const acpxSessionPath = join(this.dataDir, "acpx", "sessions", `${acpxKey}.json`);
    await this.removeAcpxEventLog(acpxSessionPath, acpxKey);
    await rm(acpxSessionPath, { force: true });
    const providerRoot = join(this.dataDir, "agents", String(input.agentId), "provider-home");
    if (input.provider === "codex") {
      await rm(join(providerRoot, "codex", "sessions", String(input.sessionId)), { recursive: true, force: true });
      return;
    }
    if (input.provider === "hermes") {
      const legacyHome = join(providerRoot, "hermes");
      await rm(join(legacyHome, "sessions", String(input.sessionId)), { recursive: true, force: true });
      if (input.providerSessionId !== null) {
        const retainedByChild = await this.removeLegacyHermesState(input.agentId, input.providerSessionId);
        if (!retainedByChild) {
          await this.removeMatchingHermesLegacyEntries(legacyHome, input.providerSessionId);
        }
      }
      return;
    }
    if (input.providerSessionId === null) return;
    await this.removeMatchingEntries(join(providerRoot, "claude"), input.providerSessionId);
  }

  private async removeAcpxEventLog(sessionPath: string, acpxKey: string): Promise<void> {
    let activePath: unknown;
    try {
      const record = JSON.parse(await readFile(sessionPath, "utf8")) as {
        event_log?: { active_path?: unknown } | null;
      };
      activePath = record.event_log?.active_path;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return;
      throw error;
    }
    if (typeof activePath !== "string") return;
    const acpxRoot = resolve(this.dataDir, "acpx");
    const resolvedActivePath = resolve(activePath);
    const relativePath = relative(acpxRoot, resolvedActivePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return;
    const eventDirectory = dirname(resolvedActivePath);
    let entries;
    try {
      entries = await readdir(eventDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(`${acpxKey}.stream`)) continue;
      await rm(join(eventDirectory, entry.name), { recursive: true, force: true });
    }
  }

  private async removeMatchingEntries(directory: string, providerSessionId: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === providerSessionId || entry.name.startsWith(`${providerSessionId}.`)) {
        await rm(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await this.removeMatchingEntries(path, providerSessionId);
      }
    }
  }

  /** Legacy Hermes histories can be removed, but isolated Session homes are never traversed. */
  private async removeMatchingHermesLegacyEntries(directory: string, providerSessionId: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === "sessions" && entry.isDirectory()) {
        await this.removeMatchingHermesLegacySessions(path, providerSessionId);
      } else if (entry.name === providerSessionId || entry.name.startsWith(`${providerSessionId}.`)) {
        await rm(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await this.removeMatchingEntries(path, providerSessionId);
      }
    }
  }

  private async removeMatchingHermesLegacySessions(directory: string, providerSessionId: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      // Isolated service Session homes are numeric directories. Do not descend into them.
      if (/^(?:0|[1-9]\d*)$/.test(entry.name)) continue;
      if (entry.name === providerSessionId || entry.name.startsWith(`${providerSessionId}.`)) {
        await rm(join(directory, entry.name), { recursive: true, force: true });
      }
    }
  }

  /**
   * Hermes stores resumable conversations in state.db. Remove one only when
   * no remaining legacy Session has it as a parent; check and deletion share
   * one SQLite transaction.
   */
  private async removeLegacyHermesState(agentId: number, providerSessionId: string): Promise<boolean> {
    const path = join(this.dataDir, "agents", String(agentId), "provider-home", "hermes", "state.db");
    try {
      await access(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const database = new Database(path);
    try {
      return database.transaction(() => {
        const child = database.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1")
          .get(providerSessionId);
        if (child !== undefined) return true;
        database.prepare("DELETE FROM messages WHERE session_id = ?").run(providerSessionId);
        database.prepare("DELETE FROM compression_locks WHERE session_id = ?").run(providerSessionId);
        database.prepare("DELETE FROM sessions WHERE id = ?").run(providerSessionId);
        return false;
      })();
    } finally {
      database.close();
    }
  }
}

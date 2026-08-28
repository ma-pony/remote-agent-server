import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
    if (input.providerSessionId === null) return;
    const home = join(providerRoot, input.provider === "claude_code" ? "claude" : "hermes");
    await this.removeMatchingEntries(home, input.providerSessionId);
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
}

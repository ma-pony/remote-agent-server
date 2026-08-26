import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

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
    const providerRoot = join(this.dataDir, "agents", String(input.agentId), "provider-home");
    if (input.provider === "codex") {
      await rm(join(providerRoot, "codex", "sessions", String(input.sessionId)), { recursive: true, force: true });
      return;
    }
    if (input.providerSessionId === null) return;
    const home = join(providerRoot, input.provider === "claude_code" ? "claude" : "hermes");
    await this.removeMatchingEntries(home, input.providerSessionId);
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

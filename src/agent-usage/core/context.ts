import { createHash } from "node:crypto";
import type { Capability, ContextBlock, ResultFirstUse } from "./context-types.js";

export const MAX_TOKENIZABLE_BLOCK_BYTES = 256 * 1024;
export const MAX_TOKENIZABLE_CONTEXT_BYTES = 1024 * 1024;
export const MAX_CONTEXT_BLOCKS = 2048;
export const MAX_CAPABILITY_REFERENCES_PER_BLOCK = 128;

export const stableHash = (...parts: string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const capabilityKey = (capability: Capability): string =>
  JSON.stringify([capability.kind, capability.serverId ?? null, capability.id]);

/** Content identity is made producer/call scoped before lifetime repeat classification. */
export const scopedContentKey = (block: ContextBlock, capability: Capability): string =>
  JSON.stringify([block.toolInvocationId ?? capabilityKey(capability), block.content.identity]);

export const classifyResultUses = <T extends {
  kind: ContextBlock["kind"];
  contentKey: string;
  historyComplete: boolean;
}>(ordered: T[]): Map<T, ResultFirstUse | null> => {
  const seen = new Set<string>();
  const result = new Map<T, ResultFirstUse | null>();
  for (const row of ordered) {
    if (row.kind !== "result") { result.set(row, null); continue; }
    if (seen.has(row.contentKey)) result.set(row, "repeat");
    else {
      result.set(row, row.historyComplete ? "first" : "unknown");
      seen.add(row.contentKey);
    }
  }
  return result;
};

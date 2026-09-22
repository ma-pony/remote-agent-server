import { createHash } from "node:crypto";
import type { Capability, ContextBlock } from "./context-types.js";

export const MAX_CONTEXT_BLOCKS = 2048;
export const MAX_CAPABILITY_REFERENCES_PER_BLOCK = 128;

export const stableHash = (...parts: string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const capabilityKey = (capability: Capability): string =>
  JSON.stringify([capability.kind, capability.serverId ?? null, capability.id]);

/** Content identity is made producer/call scoped before lifetime repeat classification. */
export const scopedContentKey = (block: ContextBlock, capability: Capability): string =>
  JSON.stringify([block.toolInvocationId ?? capabilityKey(capability), block.content.identity]);

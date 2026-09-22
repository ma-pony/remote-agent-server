import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { UsageError } from "../core/errors.js";
import type { SourceCapabilities, UsageSourceAdapter, UsageSourceEntry, UsageCollectionEntry } from "../source-coordinator.js";

export type ParsedSourceEntry = UsageSourceEntry;
export type IncrementalUsageParser = { parseLine(text: string, lineNumber: number): ParsedSourceEntry[]; snapshot(): unknown; validate(): void };
type Boundary = { identity: string; size: number; digest: string };
type Checkpoint = Boundary & { index: number; offset?: number; line?: number; state?: unknown; unterminated?: boolean; complete?: boolean };
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Authorized files only. Verify the complete prefix, but retain and parse only the unread tail. */
export class FileUsageSource implements UsageSourceAdapter {
  constructor(private readonly options: {
    resolve(input: Record<string, string>): Promise<string>;
    parse(text: string): ParsedSourceEntry[];
    capabilities: SourceCapabilities;
    appendOnly?: boolean;
    incremental?: (state?: unknown) => IncrementalUsageParser;
  }) {}

  describe(): SourceCapabilities { return this.options.capabilities; }

  async freeze(input: Record<string, string>): Promise<string> {
    const { boundary } = await this.read(input);
    return JSON.stringify(boundary);
  }

  async *collect(input: Record<string, string>, checkpoint: string | null, boundaryJson: string, signal: AbortSignal): AsyncGenerator<UsageCollectionEntry> {
    signal.throwIfAborted();
    const boundary = JSON.parse(boundaryJson) as Boundary;
    const previous = checkpoint === null ? null : JSON.parse(checkpoint) as Checkpoint;
    // freeze already verified this exact digest. No body read or parse for an unchanged completed file.
    if (previous?.digest === boundary.digest && previous.identity === boundary.identity && previous.offset === boundary.size) return;
    const incremental = this.options.appendOnly !== false ? this.options.incremental : undefined;
    const offset = incremental ? previous?.offset ?? 0 : 0;
    const { bytes, boundary: verified } = await this.read(input, boundary.size, signal, offset,
      this.options.appendOnly !== false ? previous : null);
    if (verified.identity !== boundary.identity || verified.digest !== boundary.digest) throw new UsageError("usage_source_changed");
    if (!incremental) {
      if (previous?.digest === boundary.digest && previous.identity === boundary.identity && previous.complete) return;
      const entries = this.options.parse(bytes.toString("utf8"));
      // Legacy partial checkpoints still resume the same frozen snapshot; changed snapshots reconcile by revision.
      const start = previous?.digest === boundary.digest ? previous.index : 0;
      for (let index = start; index < entries.length; index++) {
        signal.throwIfAborted();
        yield { ...entries[index]!, checkpoint: JSON.stringify({ ...boundary, index: index + 1, complete: index === entries.length - 1 } satisfies Checkpoint) };
      }
      return;
    }
    const parser = incremental(previous?.offset === undefined ? undefined : previous.state);
    let line = previous?.line ?? 0, cursor = 0, skip = previous?.offset === undefined ? 0 : previous.index;
    let lastCheckpoint = checkpoint;
    let unterminated = previous?.unterminated ?? false;
    if (unterminated && bytes.length) {
      const newline = bytes.indexOf(10);
      const prefix = bytes.subarray(0, newline < 0 ? bytes.length : newline).toString("utf8");
      if (prefix.trim()) throw new UsageError("usage_source_changed");
      cursor = newline < 0 ? bytes.length : newline + 1;
      unterminated = newline < 0;
    }
    while (cursor < bytes.length) {
      signal.throwIfAborted();
      const newline = bytes.indexOf(10, cursor), end = newline < 0 ? bytes.length : newline + 1;
      const text = bytes.subarray(cursor, newline < 0 ? end : newline).toString("utf8");
      if (newline < 0) {
        // A valid final JSON value is usable without LF; an incomplete UTF-8/JSON tail stays unread.
        try { JSON.parse(text); } catch { break; }
      }
      const state = parser.snapshot();
      const entries = parser.parseLine(text, line + 1);
      const after = parser.snapshot();
      for (let index = skip; index < entries.length; index++) {
        const complete = index === entries.length - 1;
        lastCheckpoint = JSON.stringify({ ...boundary,
          offset: offset + (complete ? end : cursor), line: complete ? line + 1 : line,
          state: complete ? after : state, index: complete ? 0 : index + 1,
          unterminated: complete && newline < 0 } satisfies Checkpoint);
        yield { ...entries[index]!, checkpoint: lastCheckpoint };
      }
      cursor = end; line++; skip = 0; unterminated = newline < 0;
    }
    // Metadata-only lines advance the parser state without inventing a usage observation.
    if (cursor === bytes.length) parser.validate();
    const finalCheckpoint = JSON.stringify({ ...boundary, offset: offset + cursor, line,
      state: parser.snapshot(), index: skip, unterminated } satisfies Checkpoint);
    if (finalCheckpoint !== lastCheckpoint) yield { checkpoint: finalCheckpoint };
    if (cursor < bytes.length) throw new UsageError("usage_source_incomplete");
  }

  private async read(input: Record<string, string>, size?: number, signal?: AbortSignal, keepFrom?: number,
    previous?: Boundary | null): Promise<{ bytes: Buffer; boundary: Boundary }> {
    signal?.throwIfAborted();
    const handle = await open(await this.options.resolve(input), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(), length = size ?? stat.size;
      if (!stat.isFile()) throw new UsageError("usage_source_not_file");
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) throw new UsageError("usage_source_too_large");
      if (stat.size < length || keepFrom !== undefined && (keepFrom < 0 || keepFrom > length)) throw new UsageError("usage_source_changed");
      const identity = digest(Buffer.from(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`));
      if (input.fileIdentity !== undefined && input.fileIdentity !== identity) throw new UsageError("usage_source_changed");
      if (previous && (previous.identity !== identity || previous.size > length)) throw new UsageError("usage_source_changed");
      const hash = createHash("sha256"), prefix = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, length)), retained: Buffer[] = [];
      let offset = 0;
      while (offset < length) {
        signal?.throwIfAborted();
        const result = await handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
        if (result.bytesRead === 0) throw new UsageError("usage_source_changed");
        const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk);
        if (previous && offset < previous.size) prefix.update(chunk.subarray(0, Math.min(chunk.length, previous.size - offset)));
        if (keepFrom !== undefined && offset + chunk.length > keepFrom) retained.push(Buffer.from(chunk.subarray(Math.max(0, keepFrom - offset))));
        offset += chunk.length;
      }
      if (previous && prefix.digest("hex") !== previous.digest) throw new UsageError("usage_source_changed");
      return { bytes: Buffer.concat(retained), boundary: { identity, size: length, digest: hash.digest("hex") } };
    } finally { await handle.close(); }
  }
}

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { UsageError } from "../core/errors.js";
import type { SourceCapabilities, UsageSourceAdapter, UsageSourceEntry, UsageCollectionEntry } from "../source-coordinator.js";

export type ParsedSourceEntry = UsageSourceEntry;
export type IncrementalUsageParser = { parseLine(text: string, lineNumber: number): ParsedSourceEntry[]; snapshot(): unknown; validate(): void };
type Boundary = { identity: string; size: number; digest: string };
type Checkpoint = Boundary & { index: number; offset?: number; line?: number; state?: unknown; unterminated?: boolean; complete?: boolean };
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileStamp = (stat: Stats) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** Authorized files only. Verify the complete prefix, then stream only the unread records. */
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
    const handle = await this.open(input);
    try {
      const { boundary } = await this.read(handle, input);
      return JSON.stringify(boundary);
    } finally { await handle.close(); }
  }

  async *collect(input: Record<string, string>, checkpoint: string | null, boundaryJson: string, signal: AbortSignal): AsyncGenerator<UsageCollectionEntry> {
    signal.throwIfAborted();
    const boundary = JSON.parse(boundaryJson) as Boundary;
    const previous = checkpoint === null ? null : JSON.parse(checkpoint) as Checkpoint;
    // freeze already verified this exact digest. No body read or parse for an unchanged completed file.
    if (previous?.digest === boundary.digest && previous.identity === boundary.identity && previous.offset === boundary.size) return;
    const incremental = this.options.appendOnly !== false ? this.options.incremental : undefined;
    const offset = incremental ? previous?.offset ?? 0 : 0;
    const handle = await this.open(input);
    try {
      const { bytes, boundary: verified, stamp: initialStamp } = await this.read(handle, input, boundary.size, signal, incremental ? undefined : 0,
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
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > boundary.size) throw new UsageError("usage_source_changed");
      let line = previous?.line ?? 0, cursor = offset, skip = previous?.offset === undefined ? 0 : previous.index;
      let lastCheckpoint = checkpoint;
      let unterminated = previous?.unterminated ?? false;
      let stamp = initialStamp;
      const verifyChange = async () => {
        if (fileStamp(await handle.stat()) === stamp) return;
        // Appends are safe, but a rewrite of the frozen prefix must never supply new observations.
        const checked = await this.read(handle, input, boundary.size, signal);
        if (checked.boundary.digest !== boundary.digest) throw new UsageError("usage_source_changed");
        stamp = checked.stamp;
      };
      for await (const record of this.lines(handle, offset, boundary.size, signal, verifyChange)) {
        signal.throwIfAborted();
        const text = record.bytes.toString("utf8"), end = record.end;
        if (unterminated) {
          if (text.trim()) throw new UsageError("usage_source_changed");
          cursor = end; unterminated = !record.terminated;
          continue;
        }
        if (!record.terminated) {
          // A valid final JSON value is usable without LF; an incomplete UTF-8/JSON tail stays unread.
          try { JSON.parse(text); } catch { break; }
        }
        const state = parser.snapshot();
        const entries = parser.parseLine(text, line + 1);
        const after = parser.snapshot();
        for (let index = skip; index < entries.length; index++) {
          signal.throwIfAborted();
          const complete = index === entries.length - 1;
          lastCheckpoint = JSON.stringify({ ...boundary,
            offset: complete ? end : cursor, line: complete ? line + 1 : line,
            state: complete ? after : state, index: complete ? 0 : index + 1,
            unterminated: complete && !record.terminated } satisfies Checkpoint);
          yield { ...entries[index]!, checkpoint: lastCheckpoint };
        }
        cursor = end; line++; skip = 0; unterminated = !record.terminated;
        if (line % 256 === 0) await setImmediate(undefined, { signal });
      }
      // Metadata-only lines advance the parser state without inventing a usage observation.
      if (cursor === boundary.size) parser.validate();
      const finalCheckpoint = JSON.stringify({ ...boundary, offset: cursor, line,
        state: parser.snapshot(), index: skip, unterminated } satisfies Checkpoint);
      if (finalCheckpoint !== lastCheckpoint) yield { checkpoint: finalCheckpoint };
      if (cursor < boundary.size) throw new UsageError("usage_source_incomplete");
    } finally { await handle.close(); }
  }

  private open(input: Record<string, string>): Promise<FileHandle> {
    return this.options.resolve(input).then((path) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  }

  /** Verify the frozen file and previous prefix before exposing any observations. */
  private async read(handle: FileHandle, input: Record<string, string>, size?: number, signal?: AbortSignal, keepFrom?: number,
    previous?: Boundary | null): Promise<{ bytes: Buffer; boundary: Boundary; stamp: string }> {
    signal?.throwIfAborted();
    const stat = await handle.stat(), length = size ?? stat.size;
    if (!stat.isFile()) throw new UsageError("usage_source_not_file");
    if (!Number.isSafeInteger(length) || length < 0
      || (!(this.options.appendOnly !== false && this.options.incremental) && length > MAX_SNAPSHOT_BYTES)) throw new UsageError("usage_source_too_large");
    if (stat.size < length || keepFrom !== undefined && (keepFrom < 0 || keepFrom > length)) throw new UsageError("usage_source_changed");
    const identity = digest(Buffer.from(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`));
    if (input.fileIdentity !== undefined && input.fileIdentity !== identity) throw new UsageError("usage_source_changed");
    if (previous && (previous.identity !== identity || previous.size > length)) throw new UsageError("usage_source_changed");
    const hash = createHash("sha256"), prefix = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, length)), retained: Buffer[] = [];
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
    return { bytes: Buffer.concat(retained), boundary: { identity, size: length, digest: hash.digest("hex") }, stamp: fileStamp(stat) };
  }

  /** Retain at most one bounded line; byte offsets remain exact across UTF-8 and chunk boundaries. */
  private async *lines(handle: FileHandle, start: number, length: number, signal: AbortSignal, verifyChange: () => Promise<void>) {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, length - start));
    let offset = start, parts: Buffer[] = [], lineBytes = 0;
    while (offset < length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (bytesRead === 0) throw new UsageError("usage_source_changed");
      await verifyChange();
      let cursor = 0;
      while (cursor < bytesRead) {
        const found = buffer.indexOf(10, cursor);
        const newline = found >= 0 && found < bytesRead ? found : -1;
        const end = newline < 0 ? bytesRead : newline;
        lineBytes += end - cursor;
        if (lineBytes > MAX_LINE_BYTES) throw new UsageError("usage_source_too_large");
        parts.push(Buffer.from(buffer.subarray(cursor, end)));
        if (newline >= 0) {
          yield { bytes: Buffer.concat(parts, lineBytes), end: offset + newline + 1, terminated: true };
          parts = []; lineBytes = 0;
        }
        cursor = newline < 0 ? bytesRead : newline + 1;
      }
      offset += bytesRead;
    }
    if (lineBytes) yield { bytes: Buffer.concat(parts, lineBytes), end: length, terminated: false };
  }
}

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { UsageError } from "./core/errors.js";
import { ModelTokenizers } from "./core/tokenizers.js";

export const tokenizerProfilesSchema = z.array(z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  modelProvider: z.string().trim().min(1).max(100).optional(),
  tokenizerPath: z.string().refine(isAbsolute, "Tokenizer paths must be absolute"),
  configPath: z.string().refine(isAbsolute, "Tokenizer paths must be absolute"),
  tokenizerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()).max(16);
export type TokenizerProfileConfig = z.infer<typeof tokenizerProfilesSchema>[number];

/** Bounded, local-only startup loading; never called on the capture/request path. */
export const loadModelTokenizers = (input: TokenizerProfileConfig[] = [], automaticCacheDirectory?: string): ModelTokenizers => {
  const profiles = tokenizerProfilesSchema.parse(input);
  let totalBytes = 0;
  const load = (path: string, digest: string, limit: number): Record<string, unknown> => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit || totalBytes + stat.size > 64 * 1024 * 1024) throw new Error();
      const buffer = Buffer.alloc(stat.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (read === 0) break;
        bytes += read;
      }
      if (bytes !== stat.size || createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex") !== digest) throw new Error();
      totalBytes += bytes;
      const parsed: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new UsageError("usage_tokenizer_asset_invalid"); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  return new ModelTokenizers(profiles.map((profile) => ({ ...profile,
    tokenizerJson: load(profile.tokenizerPath, profile.tokenizerSha256, 16 * 1024 * 1024),
    tokenizerConfig: load(profile.configPath, profile.configSha256, 1024 * 1024)
  })), { automaticCacheDirectory });
};

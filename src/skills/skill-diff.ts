import { isUtf8 } from "node:buffer";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../project-environments/project-environment-commands.js";
import type { SkillFile } from "./skill-content.js";

export const skillPreviewFileLimit = 1024 * 1024;
const patchLimit = 64 * 1024;
export type SkillPreviewKind = "text" | "binary" | "unsupported_encoding" | "too_large";
export type SkillFilePreview = { path: string } & (
  | { kind: "text"; patch: string; truncated: boolean }
  | { kind: "binary" | "unsupported_encoding" }
  | { kind: "too_large"; limitBytes: number }
);

export const skillPreviewKind = (before?: SkillFile, after?: SkillFile): SkillPreviewKind => {
  const contents = [before, after].flatMap((file) => file === undefined ? [] : [file.contents]);
  if (contents.some((bytes) => bytes.includes(0))) return "binary";
  if (contents.some((bytes) => !isUtf8(bytes))) return "unsupported_encoding";
  return contents.some((bytes) => bytes.length > skillPreviewFileLimit) ? "too_large" : "text";
};

/** Compare inert byte snapshots, never execute package code, attributes or external diff drivers. */
export const previewSkillFile = async (
  path: string, before: SkillFile | undefined, after: SkillFile | undefined, signal: AbortSignal
): Promise<SkillFilePreview> => {
  const kind = skillPreviewKind(before, after);
  if (kind === "too_large") return { path, kind, limitBytes: skillPreviewFileLimit };
  if (kind !== "text") return { path, kind };
  const previous = before?.contents ?? Buffer.alloc(0);
  const next = after?.contents ?? Buffer.alloc(0);
  if (previous.equals(next)) return { path, kind, patch: "", truncated: false };
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "skill-diff-"));
  try {
    await Promise.all([writeFile(join(directory, "before"), previous), writeFile(join(directory, "after"), next)]);
    // Ignore inherited Git routing/configuration; this is a local comparison with fixed file names.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    await runProcess("git", ["--no-pager", "-c", "core.attributesFile=/dev/null", "-c", "core.hooksPath=/dev/null",
      "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--no-prefix", "--text", "--unified=3",
      "--output=patch", "--", "before", "after"], {
      cwd: directory, environment: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" },
      signal, timeoutMs: 5_000, successExitCodes: [0, 1]
    });
    // The disk patch is bounded by the two input limits; only its preview prefix enters memory.
    const output = await open(join(directory, "patch"), "r");
    try {
      const truncated = (await output.stat()).size > patchLimit;
      const bytes = Buffer.alloc(patchLimit);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await output.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const patch = new TextDecoder().decode(bytes.subarray(0, length), { stream: truncated });
      return { path, kind, patch, truncated };
    } finally { await output.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

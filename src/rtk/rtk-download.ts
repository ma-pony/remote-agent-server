import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { rtkVersionPattern, type RtkRelease } from "./rtk-types.js";

export class RtkError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const compareRtkVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

export const rtkTarget = (platform: string, arch: string): string => {
  if (!["arm64", "x64"].includes(arch) || !["darwin", "linux"].includes(platform)) throw new RtkError("rtk_platform_unsupported");
  return `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : arch === "arm64" ? "unknown-linux-gnu" : "unknown-linux-musl"}`;
};

const releaseSchema = z.object({
  tag_name: z.string(), draft: z.literal(false), prerelease: z.literal(false),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullable() }))
});

/** Bounded reads apply to JSON and archives, including chunked HTTP responses. */
export const fetchRtkBytes = async (fetcher: typeof fetch, url: string, signal: AbortSignal, maxBytes: number, timeoutMs = 30_000): Promise<Buffer> => {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "remote-agent-server" }
  });
  if (!response.ok || !response.body) throw new RtkError("rtk_download_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RtkError("rtk_download_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
};

export const fetchRtkRelease = async (
  fetcher: typeof fetch, target: string, version: string | null, signal: AbortSignal
): Promise<RtkRelease> => {
  if (version !== null && !rtkVersionPattern.test(version)) throw new RtkError("rtk_invalid_version");
  const url = `https://api.github.com/repos/rtk-ai/rtk/releases/${version === null ? "latest" : `tags/v${version}`}`;
  const bytes = await fetchRtkBytes(fetcher, url, signal, 2 * 1024 * 1024);
  let release: z.infer<typeof releaseSchema>;
  try { release = releaseSchema.parse(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new RtkError("rtk_invalid_release"); }
  const resolved = release.tag_name.replace(/^v/, "");
  if (!rtkVersionPattern.test(resolved) || (version !== null && version !== resolved)) throw new RtkError("rtk_invalid_release");
  const name = `rtk-oss-${target}.tar.gz`;
  const asset = release.assets.find((item) => item.name === name);
  const expectedUrl = `https://github.com/rtk-ai/rtk/releases/download/v${resolved}/${name}`;
  if (!asset || asset.browser_download_url !== expectedUrl || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new RtkError("rtk_release_asset_unavailable");
  return { version: resolved, url: `https://github.com/rtk-ai/rtk/releases/tag/v${resolved}`, downloadUrl: expectedUrl, sha256: asset.digest!.slice(7) };
};

/** Extract only one regular rtk executable; archive paths are never written to disk. */
export const unpackRtk = async (archive: Buffer, sha256: string): Promise<Buffer> => {
  if (createHash("sha256").update(archive).digest("hex") !== sha256) throw new RtkError("rtk_checksum_mismatch");
  let tar: Buffer;
  try { tar = await promisify(gunzip)(archive, { maxOutputLength: 64 * 1024 * 1024 }); }
  catch { throw new RtkError("rtk_invalid_archive"); }
  let binary: Buffer | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new RtkError("rtk_invalid_archive");
    const size = Number.parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new RtkError("rtk_invalid_archive");
    if (name.split("/").at(-1) === "rtk") {
      if (binary || ![0, 48].includes(header[156]!) || size === 0) throw new RtkError("rtk_invalid_archive");
      binary = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary) throw new RtkError("rtk_invalid_archive");
  return binary;
};

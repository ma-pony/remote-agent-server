import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentStore } from "./attachment-store.js";
import { isNativeImage } from "./attachment-types.js";

/** A fresh unpredictable directory avoids reusing paths or symlinks left by earlier turns. */
export const prepareAttachments = async (store: AttachmentStore, runId: number, workspacePath: string, text: string, signal: AbortSignal) => {
  const metadata = store.list({ runId });
  if (metadata.length === 0) return { text };
  signal.throwIfAborted();
  const directory = await mkdtemp(join(workspacePath, ".remote-agent-attachments-"));
  const references: string[] = [];
  const images: Array<{ mediaType: string; data: string }> = [];
  try {
    for (const item of metadata) {
      signal.throwIfAborted();
      const stored = store.read({ runId }, item.id);
      if (stored === undefined) throw new Error("attachment_unavailable");
      const path = join(directory, `${item.id}-${item.name}`);
      await writeFile(path, stored.bytes, { flag: "wx", mode: 0o600, signal });
      references.push(JSON.stringify({ name: item.name, mediaType: item.mediaType, path }));
      if (isNativeImage(item.mediaType)) images.push({ mediaType: item.mediaType, data: stored.bytes.toString("base64") });
    }
    signal.throwIfAborted();
    return {
      text: [text, "Attached files in this Session workspace (JSON references):", ...references].filter(Boolean).join("\n"),
      ...(images.length === 0 ? {} : { attachments: images })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

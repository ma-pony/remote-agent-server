import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Publish a private Home file without writing through an imported host symlink. */
export const writeProviderHomeFile = async (path: string, content: string): Promise<void> => {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
};

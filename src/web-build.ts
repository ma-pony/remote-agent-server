import { existsSync } from "node:fs";
import { join } from "node:path";

/** Prevents production from starting an API-only process that can only render a blank Web page. */
export const assertWebBuildAvailable = (webRoot: string): void => {
  const indexPath = join(webRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Web build not found at ${indexPath}. Run pnpm build before pnpm start.`);
  }
};

import { exec, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareHermesAcp } from "../src/runtime/hermes-acp.js";

const python = (() => {
  try { return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(); }
  catch { return undefined; }
})();

// Other Providers do not require Python. Exercise the adapter when Python is available.
describe.skipIf(!python)("Hermes ACP failure boundary", () => {
  it("preserves structured failures, cancellation and Session recovery without matching reply text", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-acp 'quoted-"));
    try {
      const fixture = join(import.meta.dirname, "fixtures/hermes-acp.py");
      const executable = join(root, "hermes");
      const original = `#!${python} ${fixture}\n# Native CLI fixture\n`;
      await writeFile(executable, original, { mode: 0o700 });
      const command = await prepareHermesAcp(root);
      const { stdout } = await promisify(exec)(command, {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` }, timeout: 5_000
      });
      const failure = { code: -32603, message: "Hermes upstream request failed" };
      expect(JSON.parse(stdout)).toEqual([
        failure, { stopReason: "end_turn" }, { stopReason: "end_turn" }, { stopReason: "cancelled" }, failure
      ]);
      expect(await readFile(executable, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const pidFile = process.argv[2];
if (pidFile === undefined) throw new Error("Missing PID file");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  stdio: "ignore"
});
descendant.unref();
await writeFile(pidFile, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));

if (process.argv.includes("--exit-parent")) process.exit(0);
setInterval(() => {}, 1_000);

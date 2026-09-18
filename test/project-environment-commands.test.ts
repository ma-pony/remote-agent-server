import { expect, it } from "vitest";
import { runProcess } from "../src/project-environments/project-environment-commands.js";

it("accepts explicit nonzero success codes without weakening the default command contract", async () => {
  const args = ["-e", "process.stdout.write('difference'); process.exitCode = 1"];
  const options = { environment: process.env, signal: new AbortController().signal };
  await expect(runProcess(process.execPath, args, options)).rejects.toThrow("difference");
  await expect(runProcess(process.execPath, args, { ...options, successExitCodes: [0, 1] })).resolves.toMatchObject({ stdout: "difference" });
  await expect(runProcess(process.execPath, ["-e", "process.exitCode = 2"], { ...options, successExitCodes: [0, 1] })).rejects.toThrow("Command exited with 2");
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { assertWebBuildAvailable } from "../src/web-build.js";

it("生产启动在 Web 构建缺失时明确失败，构建完整时通过", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-web-build-"));
  try {
    expect(() => assertWebBuildAvailable(root)).toThrow(`Web build not found at ${join(root, "index.html")}`);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Remote Agent</title>");
    expect(() => assertWebBuildAvailable(root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

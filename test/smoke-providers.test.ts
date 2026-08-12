import { describe, expect, it } from "vitest";

import { readSmokeConfig } from "../scripts/smoke-providers.js";

describe("provider smoke configuration", () => {
  it("requires an API token before it can contact the server", () => {
    expect(() => readSmokeConfig({})).toThrow("API_TOKEN");
  });

  it("uses a local API URL and bounded polling defaults", () => {
    expect(readSmokeConfig({ API_TOKEN: "test-token" })).toMatchObject({
      baseUrl: "http://127.0.0.1:3000/api",
      pollIntervalMs: 1_000,
      runTimeoutMs: 300_000
    });
  });
});

import { afterEach, expect, it, vi } from "vitest";

import viteConfig from "../vite.config.js";
import * as environmentFile from "../src/environment-file.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("Vite reads the same local .env PORT as the backend without requiring shell source", async () => {
  vi.spyOn(environmentFile, "readEnvironmentFile").mockReturnValue({ PORT: "3211" });
  const config = typeof viteConfig === "function"
    ? await viteConfig({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false })
    : viteConfig;
  expect(config.server?.proxy?.["/api"]).toBe("http://127.0.0.1:3211");
  expect(config.server?.proxy?.["/integration"]).toBe("http://127.0.0.1:3211");
});

it("Vite 开发代理跟随服务 PORT", async () => {
  vi.stubEnv("PORT", "3100");
  const config = typeof viteConfig === "function"
    ? await viteConfig({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false })
    : viteConfig;
  const apiProxy = config.server?.proxy?.["/api"];
  const integrationProxy = config.server?.proxy?.["/integration"];
  const target = (proxy: typeof apiProxy): string | undefined => typeof proxy === "string" ? proxy : proxy?.target;

  expect(target(apiProxy)).toBe("http://127.0.0.1:3100");
  expect(target(integrationProxy)).toBe("http://127.0.0.1:3100");
});

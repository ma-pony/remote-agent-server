import { afterEach, expect, it, vi } from "vitest";

import viteConfig from "../vite.config.js";

afterEach(() => vi.unstubAllEnvs());

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

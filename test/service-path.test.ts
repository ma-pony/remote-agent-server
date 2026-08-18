import { delimiter, dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyServicePath,
  buildServicePath,
  removeServiceSecretsFromEnvironment
} from "../src/runtime/service-path.js";

describe("service PATH bootstrap", () => {
  it("将当前 Node 目录、登录 Shell PATH 和服务 PATH 按顺序合并去重", () => {
    const node = "/opt/nvm/node-v22/bin/node";

    expect(buildServicePath({
      execPath: node,
      loginPath: ["/opt/nvm/node-v24/bin", "/opt/homebrew/bin", "/home/user/pnpm"].join(delimiter),
      servicePath: ["/usr/bin", "/bin", "/opt/homebrew/bin"].join(delimiter)
    })).toBe([
      dirname(node),
      "/opt/nvm/node-v24/bin",
      "/opt/homebrew/bin",
      "/home/user/pnpm",
      "/usr/bin",
      "/bin"
    ].join(delimiter));
  });

  it("从登录 Shell 自动加载 PATH 并写回服务环境", () => {
    const environment = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
    const loadLoginPath = vi.fn(() => "/opt/homebrew/bin:/home/user/pnpm:/usr/bin");

    const resolved = applyServicePath({
      environment,
      execPath: "/opt/nvm/node-v22/bin/node",
      loadLoginPath
    });

    expect(loadLoginPath).toHaveBeenCalledWith("/bin/zsh", environment);
    expect(resolved).toBe("/opt/nvm/node-v22/bin:/opt/homebrew/bin:/home/user/pnpm:/usr/bin:/bin");
    expect(environment.PATH).toBe(resolved);
  });

  it("登录 Shell 读取失败时仍加入当前 Node 目录并保留服务 PATH", () => {
    const environment = { PATH: "/usr/bin:/bin" };

    const resolved = applyServicePath({
      environment,
      execPath: "/opt/nvm/node-v22/bin/node",
      loadLoginPath: () => {
        throw new Error("shell failed");
      }
    });

    expect(resolved).toBe("/opt/nvm/node-v22/bin:/usr/bin:/bin");
    expect(environment.PATH).toBe(resolved);
  });

  it("Provider 和项目准备命令不会继承服务管理及验收凭证", () => {
    const environment = {
      API_TOKEN: "management-secret",
      SMOKE_API_TOKEN: "smoke-management-secret",
      SMOKE_AGENT_ID: "agent-id",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "provider-credential"
    };

    removeServiceSecretsFromEnvironment(environment);

    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "provider-credential"
    });
  });
});

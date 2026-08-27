import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { ConcurrencySettingsStore } from "../src/settings/concurrency-settings-store.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = { authorization: `Bearer ${apiToken}` };
const resources: Array<() => Promise<void>> = [];

const createApp = async () => {
  const { db } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "remote-agent-concurrency-"));
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir: root,
      databasePath: ":memory:",
      projectEnvironmentsRoot: "/unused/environments",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 4,
      maxConcurrentWebhookDeliveries: 4,
      maxConcurrentEnvironmentBuilds: 1,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
      projectPrepareTimeoutMs: 30 * 60 * 1000,
      sessionRetentionMs: 0
    },
    db,
    runtime: createFakeRuntime()
  });
  await app.ready();
  resources.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, db };
};

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (close) => close()));
});

describe("Concurrency settings API", () => {
  it("鉴权后读取并一次保存三类全局并发", async () => {
    const { app } = await createApp();

    const initial = await app.inject({
      method: "GET",
      url: "/api/system-settings/concurrency",
      headers: authHeaders
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/api/system-settings/concurrency",
      headers: authHeaders,
      payload: {
        globalRunConcurrency: 8,
        webhookConcurrency: 6,
        environmentBuildConcurrency: 2
      }
    });
    const loaded = await app.inject({
      method: "GET",
      url: "/api/system-settings/concurrency",
      headers: authHeaders
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      globalRunConcurrency: 4,
      webhookConcurrency: 4,
      environmentBuildConcurrency: 1
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      globalRunConcurrency: 8,
      webhookConcurrency: 6,
      environmentBuildConcurrency: 2
    });
    expect(loaded.json()).toEqual(updated.json());
  });

  it("拒绝缺字段、额外字段和范围外数值且保持原值", async () => {
    const { app } = await createApp();
    const payloads = [
      { globalRunConcurrency: 8, webhookConcurrency: 6 },
      { globalRunConcurrency: 0, webhookConcurrency: 6, environmentBuildConcurrency: 2 },
      { globalRunConcurrency: 8, webhookConcurrency: 65, environmentBuildConcurrency: 2 },
      { globalRunConcurrency: 8, webhookConcurrency: 6, environmentBuildConcurrency: 2, extra: true }
    ];

    for (const payload of payloads) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/system-settings/concurrency",
        headers: authHeaders,
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { code: "invalid_request", message: "Invalid concurrency settings" }
      });
    }

    const loaded = await app.inject({
      method: "GET",
      url: "/api/system-settings/concurrency",
      headers: authHeaders
    });
    expect(loaded.json()).toEqual({
      globalRunConcurrency: 4,
      webhookConcurrency: 4,
      environmentBuildConcurrency: 1
    });
  });

  it("拒绝没有 API Token 的系统设置请求", async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: "GET", url: "/api/system-settings/concurrency" });

    expect(response.statusCode).toBe(401);
  });
});

describe("ConcurrencySettingsStore", () => {
  it("只在事务提交后通知一次完整快照，并支持取消订阅", () => {
    const { db } = createTestDatabase();
    const store = new ConcurrencySettingsStore(db);
    const received: unknown[] = [];
    const subscribable = store as unknown as {
      subscribe(listener: (settings: unknown) => void): () => void;
    };
    expect(typeof subscribable.subscribe).toBe("function");
    const unsubscribe = subscribable.subscribe((settings) => received.push(settings));

    store.update({
      globalRunConcurrency: 9,
      webhookConcurrency: 7,
      environmentBuildConcurrency: 3
    });
    unsubscribe();
    store.update({
      globalRunConcurrency: 4,
      webhookConcurrency: 4,
      environmentBuildConcurrency: 1
    });

    expect(received).toEqual([{
      globalRunConcurrency: 9,
      webhookConcurrency: 7,
      environmentBuildConcurrency: 3
    }]);
    db.close();
  });
});

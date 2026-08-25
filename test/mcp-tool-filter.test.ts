import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterListedTools,
  requireAllowedTool,
  wrapMcpServerWithToolFilter
} from "../src/mcp/mcp-tool-filter.js";
import { createMcpToolFilterServer } from "../src/mcp/mcp-tool-filter-process.js";

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closeCallbacks.splice(0).map((close) => close())));

describe("MCP tool filter", () => {
  it("从 Session 工作目录启动开发版代理时仍能加载 tsx", () => {
    const wrapped = wrapMcpServerWithToolFilter({
      type: "http",
      name: "grab-manager",
      url: "https://example.test/mcp",
      headers: []
    }, ["ticket_get"], 30);
    expect(wrapped.type).toBe("stdio");
    if (wrapped.type !== "stdio") return;

    const result = spawnSync(wrapped.command, wrapped.args, {
      cwd: tmpdir(),
      encoding: "utf8",
      env: process.env
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing MCP tool filter configuration");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it.runIf(process.env.REMOTE_AGENT_MCP_PROCESS_TEST === "1")(
    "从 Session 工作目录启动真实代理进程并完成过滤后的 MCP 调用",
    async () => {
      const fixture = fileURLToPath(new URL("./fixtures/mcp-filter-upstream.mjs", import.meta.url));
      const wrapped = wrapMcpServerWithToolFilter({
        type: "stdio",
        name: "fixture",
        command: process.execPath,
        args: [fixture],
        env: []
      }, ["allowed_tool"], 30);
      expect(wrapped.type).toBe("stdio");
      if (wrapped.type !== "stdio") return;

      const transport = new StdioClientTransport({
        command: wrapped.command,
        args: wrapped.args,
        cwd: tmpdir(),
        env: {
          ...getDefaultEnvironment(),
          ...Object.fromEntries(wrapped.env.map(({ name, value }) => [name, value]))
        },
        stderr: "pipe"
      });
      const client = new Client({ name: "spawned-filter-test", version: "1.0.0" });
      await client.connect(transport);
      closeCallbacks.push(() => client.close());

      expect(client.getInstructions()).toBe("测试上游说明");
      expect((await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(({ name }) => name))
        .toEqual(["allowed_tool"]);
      expect(await client.listResources(undefined, { cacheMode: "bypass" })).toMatchObject({
        resources: [{ uri: "docs://guide", name: "Guide" }]
      });
      await expect(client.callTool({ name: "hidden_tool", arguments: {} }))
        .rejects.toThrow('MCP tool "hidden_tool" is not allowed');
      expect(await client.callTool({ name: "allowed_tool", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "allowed_tool" }]
      });
    }
  );

  it("只过滤 tools/list 的工具数组并保留完整工具元数据和结果元数据", () => {
    const result = {
      tools: [
        {
          name: "ticket_get",
          description: "读取工单",
          inputSchema: { type: "object", properties: { ticketId: { type: "integer" } } },
          annotations: { readOnlyHint: true },
          _meta: { provider: { nested: true } }
        },
        { name: "ticket_finalize", inputSchema: { type: "object" } }
      ],
      nextCursor: "cursor-2",
      _meta: { traceId: "trace-1" }
    };

    expect(filterListedTools(result, new Set(["ticket_get"]))).toEqual({
      tools: [result.tools[0]],
      nextCursor: "cursor-2",
      _meta: { traceId: "trace-1" }
    });
  });

  it("拒绝白名单外的 tools/call", () => {
    expect(() => requireAllowedTool("ticket_finalize", new Set(["ticket_get"])))
      .toThrowError('MCP tool "ticket_finalize" is not allowed');
    expect(() => requireAllowedTool("ticket_get", new Set(["ticket_get"]))).not.toThrow();
  });

  it("通过真实 MCP 协议隐藏工具并拒绝手工调用，同时原样转发允许工具结果", async () => {
    const upstream = {
      listTools: vi.fn(async () => ({
        tools: [
          { name: "ticket_get", description: "读取", inputSchema: { type: "object" }, _meta: { nested: true } },
          { name: "ticket_finalize", inputSchema: { type: "object" } }
        ],
        _meta: { upstreamList: true }
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "done" }],
        structuredContent: { taskId: 42 },
        _meta: { upstreamResult: { nested: true } }
      }))
    };
    const server = createMcpToolFilterServer("grab-manager", ["ticket_get"], upstream);
    const client = new Client({ name: "filter-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(() => client.close(), () => server.close());

    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools).toEqual([expect.objectContaining({
      name: "ticket_get", inputSchema: { type: "object" }, _meta: { nested: true }
    })]);
    expect(listed._meta).toMatchObject({ upstreamList: true });

    await expect(client.callTool({ name: "ticket_finalize", arguments: {} }))
      .rejects.toThrow('MCP tool "ticket_finalize" is not allowed');
    expect(upstream.callTool).not.toHaveBeenCalled();

    const called = await client.callTool({ name: "ticket_get", arguments: { ticketId: 1 } });
    expect(upstream.callTool).toHaveBeenCalledWith(
      { name: "ticket_get", arguments: { ticketId: 1 } },
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 0x7fffffff })
    );
    expect(called).toMatchObject({
      content: [{ type: "text", text: "done" }],
      structuredContent: { taskId: 42 },
      _meta: { upstreamResult: { nested: true } }
    });
  });

  it("过滤工具时保留上游 Resources、Prompts 和 Completion 能力", async () => {
    const upstream = {
      getServerCapabilities: () => ({
        tools: {},
        resources: {},
        prompts: {},
        completions: {}
      }),
      getInstructions: () => "先阅读项目说明。",
      listTools: vi.fn(async () => ({ tools: [{ name: "ticket_get", inputSchema: { type: "object" } }] })),
      callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] })),
      listResources: vi.fn(async () => ({
        resources: [{ uri: "docs://guide", name: "Guide", mimeType: "text/plain" }],
        _meta: { source: "upstream" }
      })),
      listResourceTemplates: vi.fn(async () => ({
        resourceTemplates: [{ uriTemplate: "docs://{name}", name: "Document" }]
      })),
      readResource: vi.fn(async () => ({
        contents: [{ uri: "docs://guide", mimeType: "text/plain", text: "guide body" }]
      })),
      subscribeResource: vi.fn(async () => ({})),
      unsubscribeResource: vi.fn(async () => ({})),
      listPrompts: vi.fn(async () => ({ prompts: [{ name: "summarize", description: "总结内容" }] })),
      getPrompt: vi.fn(async () => ({
        description: "总结内容",
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "请总结" } }]
      })),
      complete: vi.fn(async () => ({ completion: { values: ["guide"], total: 1, hasMore: false } })),
      setLoggingLevel: vi.fn(async () => ({}))
    };
    const server = createMcpToolFilterServer("grab-manager", ["ticket_get"], upstream);
    const client = new Client({ name: "filter-capabilities-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(() => client.close(), () => server.close());

    expect(client.getInstructions()).toBe("先阅读项目说明。");
    expect(await client.listResources(undefined, { cacheMode: "bypass" })).toMatchObject({
      resources: [{ uri: "docs://guide", name: "Guide" }],
      _meta: { source: "upstream" }
    });
    expect(await client.readResource({ uri: "docs://guide" }, { cacheMode: "bypass" })).toMatchObject({
      contents: [{ uri: "docs://guide", text: "guide body" }]
    });
    expect(await client.listPrompts(undefined, { cacheMode: "bypass" })).toMatchObject({
      prompts: [{ name: "summarize", description: "总结内容" }]
    });
    expect(await client.getPrompt({ name: "summarize", arguments: {} })).toMatchObject({
      messages: [{ role: "user", content: { type: "text", text: "请总结" } }]
    });
    expect(await client.complete({
      ref: { type: "ref/prompt", name: "summarize" },
      argument: { name: "topic", value: "gu" }
    })).toEqual({ completion: { values: ["guide"], total: 1, hasMore: false } });
  });

  it("下游取消 tools/call 时同步取消上游调用", async () => {
    let forwardedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const upstream = {
      getServerCapabilities: () => ({ tools: {} }),
      getInstructions: () => undefined,
      listTools: vi.fn(async () => ({ tools: [{ name: "slow_tool", inputSchema: { type: "object" } }] })),
      callTool: vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
        forwardedSignal = options?.signal;
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      })
    };
    const server = createMcpToolFilterServer("slow", ["slow_tool"], upstream);
    const client = new Client({ name: "filter-cancel-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(() => client.close(), () => server.close());

    const controller = new AbortController();
    const request = client.callTool({ name: "slow_tool", arguments: {} }, { signal: controller.signal });
    await started;
    controller.abort(new Error("cancelled by downstream"));

    await expect(request).rejects.toThrow("cancelled by downstream");
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it("转发上游声明的资源列表变化通知", async () => {
    const upstreamServer = new Server(
      { name: "upstream", version: "1.0.0" },
      { capabilities: { tools: {}, resources: { listChanged: true } } }
    );
    upstreamServer.setRequestHandler("tools/list", async () => ({ tools: [] }));
    upstreamServer.setRequestHandler("tools/call", async () => ({ content: [] }));
    upstreamServer.setRequestHandler("resources/list", async () => ({ resources: [] }));
    upstreamServer.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
    upstreamServer.setRequestHandler("resources/read", async (request) => ({
      contents: [{ uri: request.params.uri, text: "" }]
    }));
    const upstreamClient = new Client({ name: "proxy-upstream", version: "1.0.0" });
    const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
    await upstreamServer.connect(upstreamServerTransport);
    await upstreamClient.connect(upstreamClientTransport);

    const proxyServer = createMcpToolFilterServer("proxy", [], upstreamClient);
    const downstreamClient = new Client({ name: "proxy-downstream", version: "1.0.0" });
    const changed = vi.fn();
    downstreamClient.setNotificationHandler("notifications/resources/list_changed", changed);
    const [downstreamClientTransport, proxyServerTransport] = InMemoryTransport.createLinkedPair();
    await proxyServer.connect(proxyServerTransport);
    await downstreamClient.connect(downstreamClientTransport);
    closeCallbacks.push(
      () => downstreamClient.close(),
      () => proxyServer.close(),
      () => upstreamClient.close(),
      () => upstreamServer.close()
    );

    await upstreamServer.notification({ method: "notifications/resources/list_changed" });

    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
});

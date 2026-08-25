import type { McpChecker } from "./mcp-checker.js";
import { McpManager } from "./mcp-manager.js";
import { wrapMcpServerWithToolFilter } from "./mcp-tool-filter.js";
import type { ResolveMcpContext, RuntimeMcpServer } from "./mcp-types.js";

export class RunMcpPreparationError extends Error {
  readonly code = "mcp_check_failed";

  constructor(message: string) {
    super(message);
    this.name = "RunMcpPreparationError";
  }
}

/** Resolves and probes all enabled MCP servers before a provider Turn starts. */
export class RunMcpPreparer {
  constructor(private readonly dependencies: { manager: McpManager; checker: McpChecker }) {}

  prepare(context: ResolveMcpContext): RuntimeMcpServer[] | Promise<RuntimeMcpServer[]> {
    let resolved;
    try {
      resolved = this.dependencies.manager.resolveEnabledForRun(context);
    } catch (_error) {
      throw new RunMcpPreparationError("MCP configuration check failed");
    }
    if (resolved.length === 0) return [];
    return Promise.all(resolved.map(async (item) => {
      const { allowedTools, ...upstream } = item.server;
      const result = await this.dependencies.checker.check(upstream, item.checkTimeoutMs);
      this.dependencies.manager.recordCheckResult(item.id, result);
      const startupTimeoutSeconds = Math.max(1, Math.ceil(item.checkTimeoutMs / 1000));
      return {
        server: allowedTools === undefined
          ? { ...upstream, startupTimeoutSeconds }
          : wrapMcpServerWithToolFilter(upstream, allowedTools, startupTimeoutSeconds),
        result
      };
    })).then((results) => {
      const failed = results.find(({ result }) => result.status === "failed");
      if (failed !== undefined) {
        throw new RunMcpPreparationError(`MCP ${failed.server.name} check failed`);
      }
      return results.filter(({ result }) => result.status === "passed").map(({ server }) => server);
    });
  }
}

import type { McpChecker } from "./mcp-checker.js";
import { McpManager } from "./mcp-manager.js";
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
      const result = await this.dependencies.checker.check(item.server, item.checkTimeoutMs);
      this.dependencies.manager.recordCheckResult(item.id, result);
      return { server: item.server, result };
    })).then((results) => {
      const failed = results.find(({ server, result }) => server.core === true && result.status === "failed");
      if (failed !== undefined) {
        throw new RunMcpPreparationError(`MCP ${failed.server.name} check failed`);
      }
      return results.filter(({ result }) => result.status === "passed").map(({ server }) => server);
    });
  }
}

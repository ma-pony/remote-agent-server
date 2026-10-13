import { expect, it, vi } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { createTestDatabase } from "./helpers.js";

it("uses indexes instead of reading historical Run bodies during startup recovery", () => {
  const { db, seed } = createTestDatabase();
  const session = seed.session();
  seed.run(session.id, "succeeded");
  const host = new HostUsageCollector(db);
  const repository = new RunRepository({ db });
  const integration = new IntegrationStore({ db });
  const prepare = db.prepare.bind(db);
  const plans: Array<{ sql: string; details: string[] }> = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!/\b(?:FROM|UPDATE) runs\b/.test(sql)) return statement;
    const recordPlan = <T>(execute: (...params: unknown[]) => T) =>
      (...params: unknown[]): T => {
        const details = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
          .map(row => row.detail);
        plans.push({ sql, details });
        return execute(...params);
      };
    statement.all = recordPlan(statement.all.bind(statement));
    statement.get = recordPlan(statement.get.bind(statement));
    statement.run = recordPlan(statement.run.bind(statement));
    return statement;
  });
  try {
    new HostUsageCollector(db);
    host.importLegacy();
    repository.recoverAfterRestart();
    repository.listQueued();
    integration.listRunsNeedingProjection();
    expect(plans.length).toBeGreaterThan(4);
    for (const { sql, details } of plans) {
      expect(details.filter(detail => /^SCAN (?:runs|r|run)$/.test(detail)), sql).toEqual([]);
    }
  } finally {
    spy.mockRestore();
    db.close();
  }
});

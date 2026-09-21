import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { UsageSourceCoordinator, type UsageSourceAdapter } from "../src/agent-usage/source-coordinator.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const setup = (adapter: UsageSourceAdapter) => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db);
  const coordinator = new UsageSourceCoordinator(store, { fixture: adapter });
  const config = {
    namespace: "test", sourceKey: "source", kind: "fixture", inputRef: { relativePath: "fixture.json" },
    mappings: [{ sourceSessionKey: "capture-1", agentId: "agent-1", sessionId: "session-1", providerEpochId: "epoch-1" }]
  };
  return { db, store, coordinator, config };
};
const adapter = (): UsageSourceAdapter => ({
  describe: () => ({ usage: "model_request", context: "none", identity: "explicit", version: "1" }),
  freeze: async () => "4",
  async *collect(_input, checkpoint, boundary) {
    for (let index = Number(checkpoint ?? 0); index < Number(boundary); index++) {
      yield { sourceSessionKey: "capture-1", observation: accountingRequests()[index]!, checkpoint: String(index + 1) };
    }
  }
});

describe("usage source coordinator", () => {
  it("commits a bounded batch and one checkpoint write instead of one per record", async () => {
    const { db, coordinator, config, store } = setup(adapter());
    const source = coordinator.registerSource(config);
    db.exec(`CREATE TABLE checkpoint_writes(value TEXT);
      CREATE TRIGGER checkpoint_write AFTER UPDATE OF checkpoint ON agent_usage_sources
      BEGIN INSERT INTO checkpoint_writes VALUES (new.checkpoint); END;`);
    await coordinator.collect(source.id);
    expect(store.summary().usage.totalTokens).toBe(3300);
    expect(db.prepare("SELECT value FROM checkpoint_writes").all()).toEqual([{ value: "4" }]);
  });
  it("registers an explicit mapping, collects and resumes without double counting", async () => {
    const { db, store, coordinator, config } = setup(adapter());
    const source = coordinator.registerSource(config);
    expect(coordinator.registerSource(config).id).toBe(source.id);
    expect(() => coordinator.registerSource({ ...config, inputRef: { relativePath: "other.json" } })).toThrow("usage_source_conflict");
    await coordinator.collect(source.id);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(3300);
    expect(coordinator.listSources("test")[0]).toMatchObject({ checkpoint: "4", status: "completed" });
    const resumed = new UsageSourceCoordinator(new UsageStore(db), { fixture: adapter() });
    await resumed.collect(source.id);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(3300);
  });

  it("commits only the processed checkpoint and can recover after a read failure", async () => {
    const failing = adapter();
    failing.collect = async function* () {
      yield { sourceSessionKey: "capture-1", observation: accountingRequests()[0]!, checkpoint: "1" };
      throw new Error("private file content must not leak");
    };
    const { db, store, coordinator, config } = setup(failing);
    const source = coordinator.registerSource(config);
    await expect(coordinator.collect(source.id)).rejects.toThrow("usage_source_failed");
    expect(coordinator.listSources("test")[0]).toMatchObject({ checkpoint: "1", status: "failed", errorCode: "usage_source_failed" });
    expect(JSON.stringify(coordinator.listSources("test"))).not.toContain("private file content");
    const resumed = new UsageSourceCoordinator(new UsageStore(db), { fixture: adapter() });
    await resumed.collect(source.id);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(3300);
  });

  it("collects unread data before declaring a reset barrier ready", async () => {
    const { store, coordinator, config } = setup(adapter());
    coordinator.registerSource(config);
    const binding = store.bindSession("test", "agent-1", "session-1");
    await coordinator.prepareMaintenance(binding, "reset", "maintenance-1");
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(3300);
    expect(coordinator.maintenance(binding)).toMatchObject({ id: "maintenance-1", state: "ready", operation: "reset" });
    await coordinator.prepareMaintenance(binding, "reset", "maintenance-1");
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(3300);
  });

  it("leaves failed maintenance pending and completes it after retry", async () => {
    const failing = adapter();
    failing.freeze = async () => { throw new Error("unreadable"); };
    const { db, store, coordinator, config } = setup(failing);
    coordinator.registerSource(config);
    const binding = store.bindSession("test", "agent-1", "session-1");
    await expect(coordinator.prepareMaintenance(binding, "cleanup", "maintenance-2")).rejects.toThrow("usage_collection_pending");
    expect(coordinator.maintenance(binding)).toMatchObject({ id: "maintenance-2", state: "draining" });
    const resumed = new UsageSourceCoordinator(new UsageStore(db), { fixture: adapter() });
    await resumed.prepareMaintenance(binding, "cleanup", "maintenance-2");
    expect(resumed.maintenance(binding)?.state).toBe("ready");
  });

  it("successive maintenance cycles ignore retained mappings and collect newly active sources", async () => {
    let oldSourceAvailable = true;
    let oldFreezes = 0;
    let newFreezes = 0;
    const cyclingAdapter: UsageSourceAdapter = {
      describe: () => ({ usage: "model_request", context: "none", identity: "explicit", version: "1" }),
      freeze: async (input) => {
        if (input.relativePath === "fixture.json") {
          oldFreezes++;
          if (!oldSourceAvailable) throw new Error("old source was purged");
          return "1";
        }
        newFreezes++;
        return "2";
      },
      async *collect(input, checkpoint, boundary) {
        const sourceSessionKey = input.relativePath === "fixture.json" ? "capture-1" : "capture-2";
        for (let index = Number(checkpoint ?? 0); index < Number(boundary); index++) {
          yield { sourceSessionKey, observation: accountingRequests()[index]!, checkpoint: String(index + 1) };
        }
      }
    };
    const { store, coordinator, config } = setup(cyclingAdapter);
    coordinator.registerSource(config);
    const binding = store.bindSession("test", "agent-1", "session-1");

    await coordinator.prepareMaintenance(binding, "reset", "maintenance-1");
    coordinator.finishMaintenance(binding);
    oldSourceAvailable = false;
    coordinator.registerSource({
      ...config,
      sourceKey: "source-2",
      inputRef: { relativePath: "fixture-2.json" },
      mappings: [{ ...config.mappings[0]!, sourceSessionKey: "capture-2", providerEpochId: "epoch-2" }]
    });

    await coordinator.prepareMaintenance(binding, "cleanup", "maintenance-2");
    coordinator.finishMaintenance(binding);

    expect(oldFreezes).toBe(1);
    expect(newFreezes).toBe(1);
    expect(store.summary({ namespace: "test" }).observedModelRequests).toBe(3);
    expect(coordinator.listSources("test").map((source) => source.mappings[0]?.state)).toEqual(["retained", "retained"]);
  });

  it("yields during large collections so the timeout can stop later records", async () => {
    const many = adapter();
    many.freeze = async () => "1000";
    many.collect = async function* (_input, checkpoint, boundary) {
      for (let index = Number(checkpoint ?? 0); index < Number(boundary); index++) {
        yield {
          sourceSessionKey: "capture-1",
          observation: { ...accountingRequests()[0]!, eventId: `event-${index}`, coverageId: `request-${index}` },
          checkpoint: String(index + 1)
        };
      }
    };
    const { store, config } = setup(many);
    const coordinator = new UsageSourceCoordinator(store, { fixture: many }, 1);
    const source = coordinator.registerSource(config);

    await expect(coordinator.collect(source.id)).rejects.toThrow("usage_collection_timeout");

    const checkpoint = Number(coordinator.listSources("test")[0]?.checkpoint);
    expect(checkpoint).toBeGreaterThan(0);
    expect(checkpoint).toBeLessThan(1000);
  });

  it("yields during large collections so deletion can revoke the remaining records", async () => {
    let coordinator!: UsageSourceCoordinator;
    let deleted!: () => void;
    const deletion = new Promise<void>((resolve) => { deleted = resolve; });
    const many = adapter();
    many.freeze = async () => "250";
    many.collect = async function* (_input, checkpoint, boundary) {
      for (let index = Number(checkpoint ?? 0); index < Number(boundary); index++) {
        if (index === 0) setTimeout(() => {
          coordinator.revokeSubject("test", "session-1");
          deleted();
        }, 0);
        yield {
          sourceSessionKey: "capture-1",
          observation: { ...accountingRequests()[0]!, eventId: `event-${index}`, coverageId: `request-${index}` },
          checkpoint: String(index + 1)
        };
      }
    };
    const { store, config } = setup(many);
    coordinator = new UsageSourceCoordinator(store, { fixture: many });
    const source = coordinator.registerSource(config);

    await coordinator.collect(source.id);
    await deletion;

    expect(coordinator.listSources("test")[0]).toMatchObject({ checkpoint: "250", status: "completed" });
    expect(coordinator.listSources("test")[0]!.rejectedRecords).toBeGreaterThan(0);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBeNull();
  });

  it("revokes mappings before late observations can restore a deleted session", async () => {
    const { store, coordinator, config } = setup(adapter());
    const source = coordinator.registerSource(config);
    coordinator.revokeSubject("test", "session-1");
    await coordinator.collect(source.id);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBeNull();
    expect(coordinator.listSources("test")[0]?.rejectedRecords).toBe(4);
    expect(() => coordinator.registerSource(config)).toThrow("usage_mapping_revoked");
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { migrate, openDatabase } from "../src/db.js";

const legacyDatabase = (path = ":memory:") => {
  const db = openDatabase(path);
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude_code', 'codex', 'hermes')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agents (id,name,provider,created_at,updated_at) VALUES
      (4,'Existing','codex','2026-10-01','2026-10-01'),
      (9,'Removed','hermes','2026-10-01','2026-10-01');
    DELETE FROM agents WHERE id=9;
  `);
  return db;
};

describe("Agent Provider migration integrity boundary", () => {
  it("checks Agent relationships without validating unrelated usage history, even on the same child table", () => {
    const db = legacyDatabase();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE usage_contexts (id INTEGER PRIMARY KEY);
        CREATE TABLE usage_exposures (context_id INTEGER REFERENCES usage_contexts(id));
        INSERT INTO usage_exposures VALUES (700);
        CREATE TABLE "mixed references" (
          agent_id INTEGER REFERENCES "AGENTS"(id),
          context_id INTEGER REFERENCES usage_contexts(id)
        );
        INSERT INTO "mixed references" VALUES (4, 800);
      `);
      db.pragma("foreign_keys = ON");

      expect(() => migrate(db)).not.toThrow();
      expect(db.prepare("SELECT provider FROM agents WHERE id=4").get()).toEqual({ provider: "codex" });
      expect(db.prepare('SELECT * FROM "mixed references"').get()).toEqual({ agent_id: 4, context_id: 800 });
      expect(db.prepare("SELECT * FROM usage_exposures").get()).toEqual({ context_id: 700 });
      expect(db.pragma("foreign_key_check")).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "usage_exposures", parent: "usage_contexts" }),
        expect.objectContaining({ table: "mixed references", parent: "usage_contexts" })
      ]));
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() => db.prepare("INSERT INTO agents(name,provider,created_at,updated_at) VALUES (?,?,?,?)")
        .run("DeepSeek", "deepseek_harness", "2026-10-22", "2026-10-22")).not.toThrow();
    } finally { db.close(); }
  });

  it.each(["incoming", "outgoing"])("rolls back an invalid %s Agent reference and can retry after reopening", direction => {
    const root = mkdtempSync(join(tmpdir(), "agent-migration-failure-"));
    const path = join(root, "database.sqlite");
    let db = legacyDatabase(path);
    try {
      db.pragma("foreign_keys = OFF");
      if (direction === "incoming") db.exec(`
        CREATE TABLE extra_agent_links (
          owner INTEGER REFERENCES agents,
          reviewer INTEGER REFERENCES "AGENTS"("ID")
        );
        INSERT INTO extra_agent_links VALUES (4, 404), (NULL, NULL);
      `);
      else db.exec("ALTER TABLE agents ADD COLUMN project_environment_id INTEGER; UPDATE agents SET project_environment_id=404");
      db.pragma("foreign_keys = ON");

      expect(() => migrate(db)).toThrow("Agent Provider migration violated foreign keys");
      expect(db.inTransaction).toBe(false);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      db.close();
      db = openDatabase(path);
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='agents'").get() as { sql: string }).sql)
        .not.toContain("deepseek_harness");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agents_new'").get()).toBeUndefined();
      expect(db.prepare("SELECT id,name,provider FROM agents").all()).toEqual([{ id: 4, name: "Existing", provider: "codex" }]);
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agents'").get()).toEqual({ seq: 9 });
      expect(() => migrate(db)).toThrow("Agent Provider migration violated foreign keys");

      if (direction === "incoming") db.exec("UPDATE extra_agent_links SET reviewer=4 WHERE reviewer=404");
      else db.exec("UPDATE agents SET project_environment_id=NULL");
      migrate(db);
      migrate(db);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      const inserted = db.prepare("INSERT INTO agents(name,provider,created_at,updated_at) VALUES (?,?,?,?)")
        .run("DeepSeek", "deepseek_harness", "2026-10-22", "2026-10-22");
      expect(Number(inserted.lastInsertRowid)).toBe(10);
    } finally {
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never evaluates unrelated foreign-key data and preserves NULL and numeric-text Agent references", () => {
    const db = legacyDatabase();
    try {
      let unrelatedReads = 0;
      db.function("unrelated_key", { deterministic: true }, () => { unrelatedReads++; return 700; });
      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE usage_contexts (id INTEGER PRIMARY KEY);
        CREATE TABLE usage_history (
          id INTEGER PRIMARY KEY,
          context_id INTEGER GENERATED ALWAYS AS (unrelated_key()) VIRTUAL REFERENCES usage_contexts(id)
        );
        INSERT INTO usage_history(id) VALUES (1), (2), (3);
        CREATE TABLE mixed_history (
          agent_id TEXT COLLATE NOCASE REFERENCES agents,
          context_id INTEGER GENERATED ALWAYS AS (unrelated_key()) VIRTUAL REFERENCES usage_contexts(id)
        );
        INSERT INTO mixed_history(agent_id) VALUES ('0004'), (NULL);
      `);
      db.pragma("foreign_keys = ON");
      unrelatedReads = 0;
      migrate(db);
      expect(unrelatedReads).toBe(0);
      expect(db.prepare("SELECT agent_id FROM mixed_history").all()).toEqual([{ agent_id: "0004" }, { agent_id: null }]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { db.close(); }
  });

  it.each(["sqliteAgentLinks", '"quoted ""links"""'])("discovers incoming references in %s without relying on table naming conventions", table => {
    const db = legacyDatabase();
    try {
      db.pragma("foreign_keys = OFF");
      db.exec(`CREATE TABLE ${table} ("owner""id" INTEGER REFERENCES "AGENTS"("ID")); INSERT INTO ${table} VALUES (404)`);
      db.pragma("foreign_keys = ON");
      expect(() => migrate(db)).toThrow("Agent Provider migration violated foreign keys");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { db.close(); }
  });

  it("recovers an interrupted rebuild from WAL and skips validation once the migration is committed", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-migration-interrupted-"));
    const path = join(root, "database.sqlite");
    let db = legacyDatabase(path);
    try {
      db.function("migration_checkpoint", { deterministic: true }, (id: number) => id);
      db.exec(`
        CREATE TABLE agent_checkpoint (
          id INTEGER PRIMARY KEY,
          agent_id INTEGER GENERATED ALWAYS AS (migration_checkpoint(id)) VIRTUAL REFERENCES agents(id)
        );
        INSERT INTO agent_checkpoint(id) VALUES (4);
      `);
      db.close();
      // A real process dies while reading an incoming FK, after the table rebuild but before commit.
      const interrupted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { migrate, openDatabase } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
        const db = openDatabase(process.argv[1]);
        db.function("migration_checkpoint", { deterministic: true }, id => {
          process.kill(process.pid, "SIGKILL");
          return id;
        });
        migrate(db);
        db.close();
      `, path], { encoding: "utf8", timeout: 10_000 });
      expect(interrupted.error, interrupted.stderr).toBeUndefined();
      expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");

      db = openDatabase(path);
      let checked = 0;
      db.function("migration_checkpoint", { deterministic: true }, (id: number) => { checked++; return id; });
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='agents'").get() as { sql: string }).sql)
        .not.toContain("deepseek_harness");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agents_new'").get()).toBeUndefined();
      expect(db.prepare("SELECT id,name,provider FROM agents").all()).toEqual([{ id: 4, name: "Existing", provider: "codex" }]);
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agents'").get()).toEqual({ seq: 9 });
      migrate(db);
      expect(checked).toBeGreaterThan(0);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      checked = 0;
      migrate(db);
      expect(checked).toBe(0);
      const inserted = db.prepare("INSERT INTO agents(name,provider,created_at,updated_at) VALUES (?,?,?,?)")
        .run("DeepSeek", "deepseek_harness", "2026-10-22", "2026-10-22");
      expect(Number(inserted.lastInsertRowid)).toBe(10);
    } finally {
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

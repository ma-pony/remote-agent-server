import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { RuntimeSessionInput } from "../src/runtime/agent-runtime.js";

const acpxMocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(),
  createRuntimeStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }))
}));

vi.mock("acpx/runtime", () => acpxMocks);

import { AcpxAgentRuntime } from "../src/runtime/acpx-runtime.js";
import { SystemProviderSessionCleaner } from "../src/runtime/provider-session-cleaner.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const configFor = (root: string): AppConfig => ({
  host: "127.0.0.1",
  port: 3000,
  apiToken: "test-token",
  dataDir: join(root, "data"),
  databasePath: join(root, "data", "db.sqlite3"),
  projectEnvironmentsRoot: join(root, "environments"),
  sessionsRoot: join(root, "sessions"),
  maxConcurrentRuns: 1,
  maxConcurrentWebhookDeliveries: 1,
  maxConcurrentEnvironmentBuilds: 1,
  projectEnvironmentCheckIntervalMs: 1,
  projectPrepareTimeoutMs: 1,
  sessionRetentionMs: 0
});

const hermesInput = (root: string): RuntimeSessionInput => ({
  sessionId: 1,
  agentId: 1,
  provider: "hermes",
  workspacePath: join(root, "workspace"),
  browserProfilePath: join(root, "browser"),
  providerSessionId: "resume-id",
  instructions: "",
  memory: "",
  mcpServers: []
});

describe("Hermes Session Home preparation", () => {
  it("pre-existing projected skills do not skip credentials or canonical state migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-home-preparation-"));
    roots.push(root);
    const config = configFor(root);
    const legacyHome = join(config.dataDir, "agents", "1", "provider-home", "hermes");
    const destination = join(legacyHome, "sessions", "1");
    const hostHome = join(root, "host-hermes");
    mkdirSync(join(destination, "skills", "_remote-agent-managed-example"), { recursive: true });
    mkdirSync(join(hostHome, "skills", "_remote-agent-managed-example"), { recursive: true });
    mkdirSync(join(legacyHome, "skills", "_remote-agent-managed-example"), { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    writeFileSync(join(destination, "skills", "_remote-agent-managed-example", "SKILL.md"), "projected skill");
    writeFileSync(join(hostHome, "skills", "_remote-agent-managed-example", "SKILL.md"), "host managed skill");
    writeFileSync(join(legacyHome, "skills", "_remote-agent-managed-example", "SKILL.md"), "legacy managed skill");
    writeFileSync(join(hostHome, "auth.json"), "host credential");
    writeFileSync(join(legacyHome, "config.yaml"), "model: test-model\n");
    const legacyState = new Database(join(legacyHome, "state.db"));
    legacyState.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT);
      CREATE TABLE compression_locks (session_id TEXT PRIMARY KEY);
    `);
    legacyState.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("parent-id", null);
    legacyState.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("resume-id", "parent-id");
    legacyState.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("other-id", null);
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(1, "resume-id");
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(2, "other-id");
    legacyState.prepare("INSERT INTO compression_locks (session_id) VALUES (?)").run("other-id");
    legacyState.close();
    vi.stubEnv("HERMES_HOME", hostHome);
    acpxMocks.createAcpRuntime.mockReturnValue({
      ensureSession: vi.fn().mockResolvedValue({ agentSessionId: "resume-id" }),
      close: vi.fn()
    });
    const runtime = new AcpxAgentRuntime(config);

    await runtime.ensureSession(hermesInput(root));

    expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe("host credential");
    expect(readFileSync(join(destination, "config.yaml"), "utf8")).toBe("model: test-model\n");
    expect(readFileSync(join(destination, "skills", "_remote-agent-managed-example", "SKILL.md"), "utf8"))
      .toBe("projected skill");
    expect(existsSync(join(destination, ".remote-agent-hermes-home-prepared-v1"))).toBe(true);
    const migratedState = new Database(join(destination, "state.db"), { readonly: true });
    expect(migratedState.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
      { id: "parent-id" }, { id: "resume-id" }
    ]);
    expect(migratedState.prepare("SELECT session_id FROM messages").all()).toEqual([{ session_id: "resume-id" }]);
    migratedState.close();
    const unchangedLegacyState = new Database(join(legacyHome, "state.db"), { readonly: true });
    expect(unchangedLegacyState.prepare("SELECT id FROM sessions WHERE id = ?").get("other-id")).toEqual({ id: "other-id" });
    unchangedLegacyState.close();
  });

  it("retains a legacy parent while its child still needs it, then migrates the child lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-parent-lineage-"));
    roots.push(root);
    const config = configFor(root);
    const legacyHome = join(config.dataDir, "agents", "1", "provider-home", "hermes");
    mkdirSync(join(legacyHome, "sessions", "parent-id"), { recursive: true });
    writeFileSync(join(legacyHome, "sessions", "parent-id", "snapshot.json"), "parent snapshot");
    const legacyState = new Database(join(legacyHome, "state.db"));
    legacyState.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT);
      CREATE TABLE compression_locks (session_id TEXT PRIMARY KEY);
    `);
    legacyState.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("parent-id", null);
    legacyState.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("child-id", "parent-id");
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(1, "parent-id");
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(2, "child-id");
    legacyState.close();
    const cleaner = new SystemProviderSessionCleaner(config.dataDir);

    await cleaner.purge({ agentId: 1, provider: "hermes", sessionId: 1, providerSessionId: "parent-id" });

    expect(readFileSync(join(legacyHome, "sessions", "parent-id", "snapshot.json"), "utf8")).toBe("parent snapshot");
    const retainedState = new Database(join(legacyHome, "state.db"), { readonly: true });
    expect(retainedState.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
      { id: "child-id" }, { id: "parent-id" }
    ]);
    retainedState.close();
    const hostHome = join(root, "host-hermes");
    mkdirSync(hostHome, { recursive: true });
    vi.stubEnv("HERMES_HOME", hostHome);
    acpxMocks.createAcpRuntime.mockReturnValue({
      ensureSession: vi.fn().mockResolvedValue({ agentSessionId: "child-id" }),
      close: vi.fn()
    });
    const runtime = new AcpxAgentRuntime(config);

    await runtime.ensureSession({ ...hermesInput(root), sessionId: 2, providerSessionId: "child-id" });

    const migratedState = new Database(join(legacyHome, "sessions", "2", "state.db"), { readonly: true });
    expect(migratedState.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
      { id: "child-id" }, { id: "parent-id" }
    ]);
    expect(migratedState.prepare("SELECT session_id FROM messages ORDER BY id").all()).toEqual([
      { session_id: "parent-id" }, { session_id: "child-id" }
    ]);
    migratedState.close();
  });
});

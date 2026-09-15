import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentsSchema } from "../src/attachments/attachment-schema.js";
import { AttachmentStore } from "../src/attachments/attachment-store.js";
import { prepareAttachments } from "../src/attachments/prepare-attachments.js";
import { migrate, openDatabase } from "../src/db.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { finishSessionMaintenance } from "../src/sessions/session-maintenance.js";
import { createTestDatabase } from "./helpers.js";

const directories: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "remote-agent-attachments-")); directories.push(path); return path; };
afterEach(() => { directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
const file = { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("file contents").toString("base64") };

describe("Message attachments", () => {
  it.each([
    { ...file, name: "../notes.txt" }, { ...file, name: "dir\\notes.txt" }, { ...file, name: "." },
    { ...file, name: "notes\n.txt" }, { ...file, name: "名".repeat(100) }, { ...file, mediaType: "text/html\r\nX:yes" },
    { ...file, data: "not base64" }, { ...file, data: "YQ" }, { ...file, data: "YR==" },
    { ...file, data: "data:text/plain;base64,YQ==" }, { ...file, mediaType: "image/png" },
    { ...file, url: "https://example.com/file.txt" }
  ])("rejects invalid attachment %j", (attachment) => {
    expect(attachmentsSchema.safeParse([attachment]).success).toBe(false);
  });

  it("accepts ordinary files, normalizes MIME and bounds count and decoded sizes", () => {
    expect(attachmentsSchema.parse([{ ...file, mediaType: "TEXT/PLAIN" }])[0]!.mediaType).toBe("text/plain");
    expect(attachmentsSchema.safeParse([{ ...file, data: "" }]).success).toBe(true);
    expect(attachmentsSchema.safeParse(Array(9).fill(file)).success).toBe(false);
    expect(attachmentsSchema.safeParse([{ ...file, data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }]).success).toBe(false);
    expect(attachmentsSchema.safeParse(Array(3).fill({ ...file, data: Buffer.alloc(7 * 1024 * 1024).toString("base64") })).success).toBe(false);
    const png = Buffer.alloc(5 * 1024 * 1024 + 1); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    expect(attachmentsSchema.safeParse([{ ...file, mediaType: "image/png", data: png.toString("base64") }]).success).toBe(false);
  });

  it("Run creation rollback leaves no attachment payload or Session claim", () => {
    const { db, seed } = createTestDatabase();
    try {
      const session = seed.session();
      const repository = new RunRepository({ db });
      expect(() => repository.create({ sessionId: session.id, input: "", attachments: [file] }, { afterInsert: () => { throw new Error("link failed"); } })).toThrow("link failed");
      expect(db.prepare("SELECT count(*) AS n FROM message_attachments").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    } finally { db.close(); }
  });

  it("queued attachments survive reopen and migration, materialize once per run without overwriting files", async () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const run = new RunRepository({ db }).create({ sessionId: session.id, input: "Read these", attachments: [file, file] });
    const directory = root();
    const databasePath = join(directory, "data.sqlite");
    await db.backup(databasePath); db.close();
    const reopened = openDatabase(databasePath);
    try {
      migrate(reopened);
      const store = new AttachmentStore(reopened);
      expect(store.list({ runId: run.id })).toHaveLength(2);
      const workspace = join(directory, "workspace"); mkdirSync(workspace);
      writeFileSync(join(workspace, file.name), "existing");
      const prompt = await prepareAttachments(store, run.id, workspace, run.input, new AbortController().signal);
      const paths = prompt.text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).path as string);
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      for (const path of paths) expect(readFileSync(path, "utf8")).toBe("file contents");
      expect(readFileSync(join(workspace, file.name), "utf8")).toBe("existing");
      const second = await prepareAttachments(store, run.id, workspace, run.input, new AbortController().signal);
      const nextPath = JSON.parse(second.text.split("\n").find((line) => line.startsWith("{"))!).path;
      expect(dirname(nextPath)).not.toBe(dirname(paths[0]!));
      const controller = new AbortController(); controller.abort();
      await expect(prepareAttachments(store, run.id, workspace, run.input, controller.signal)).rejects.toThrow();
    } finally { reopened.close(); }
  });

  it("reset retains files, cleanup drops bytes but retains metadata, deletion cascades", () => {
    const { db, seed } = createTestDatabase();
    try {
      const session = seed.session();
      const repository = new RunRepository({ db });
      const run = repository.create({ sessionId: session.id, input: "", attachments: [file] });
      db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(run.id);
      const claim = (operation: string) => db.prepare("UPDATE sessions SET status = 'running', pending_operation = ? WHERE id = ?").run(operation, session.id);
      claim("reset"); finishSessionMaintenance(db, session.id, "reset");
      expect(repository.attachments.read({ runId: run.id }, run.attachments![0]!.id)?.bytes.toString()).toBe("file contents");
      claim("cleanup"); finishSessionMaintenance(db, session.id, "cleanup");
      expect(repository.get(run.id)?.attachments).toEqual([{ ...run.attachments![0], available: false }]);
      expect(repository.attachments.read({ runId: run.id }, run.attachments![0]!.id)).toBeUndefined();
      expect(repository.get(run.id)?.input).toBe("");
      claim("delete"); finishSessionMaintenance(db, session.id, "delete");
      expect(db.prepare("SELECT count(*) AS n FROM message_attachments").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});

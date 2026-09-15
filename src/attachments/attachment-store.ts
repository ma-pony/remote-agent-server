import type Database from "better-sqlite3";
import type { Attachment, AttachmentInput } from "./attachment-types.js";

type Owner = { runId: number } | { taskId: number };
const ownerKey = (owner: Owner): [string, number] => "runId" in owner ? ["run_id", owner.runId] : ["task_id", owner.taskId];
type AttachmentRow = { id: number; name: string; media_type: string; byte_size: number; available: number };
export type StoredAttachment = Attachment & { bytes: Buffer };

/** Payloads are separate from history and only loaded for execution or explicit downloads. */
export class AttachmentStore {
  constructor(private readonly db: Database.Database) {}

  insert(sessionId: number, owner: Owner, attachments: AttachmentInput[] = []): void {
    const [column, id] = ownerKey(owner);
    const insert = this.db.prepare(`INSERT INTO message_attachments (session_id, ${column}, name, media_type, byte_size, data) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const item of attachments) {
      const bytes = Buffer.from(item.data, "base64");
      insert.run(sessionId, id, item.name, item.mediaType, bytes.length, bytes);
    }
  }

  list(owner: Owner): Attachment[] {
    const [column, id] = ownerKey(owner);
    return (this.db.prepare(`SELECT id, name, media_type, byte_size, data IS NOT NULL AS available FROM message_attachments WHERE ${column} = ? ORDER BY id`).all(id) as AttachmentRow[])
      .map((row) => ({ id: row.id, name: row.name, mediaType: row.media_type, size: row.byte_size, available: row.available === 1 }));
  }

  projection(owner: Owner): { attachments?: Attachment[] } {
    const attachments = this.list(owner);
    return attachments.length === 0 ? {} : { attachments };
  }

  read(owner: Owner, attachmentId: number): StoredAttachment | undefined {
    const [column, id] = ownerKey(owner);
    const row = this.db.prepare(`SELECT id, name, media_type, byte_size, data FROM message_attachments WHERE ${column} = ? AND id = ? AND data IS NOT NULL`)
      .get(id, attachmentId) as (AttachmentRow & { data: Buffer }) | undefined;
    return row === undefined ? undefined : { id: row.id, name: row.name, mediaType: row.media_type, size: row.byte_size, available: true, bytes: row.data };
  }

  linkTaskRun(taskId: number, runId: number): void {
    this.db.prepare("UPDATE message_attachments SET run_id = ? WHERE task_id = ? AND run_id IS NULL").run(runId, taskId);
  }
}

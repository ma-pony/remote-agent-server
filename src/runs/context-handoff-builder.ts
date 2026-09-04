import type Database from "better-sqlite3";

const MAX_HANDOFF_BYTES = 24 * 1024;
const MAX_FIELD_BYTES = 4 * 1024;

type HandoffRunRow = {
  id: number;
  status: "succeeded" | "failed" | "cancelled";
  input: string;
  result: string | null;
  error: string | null;
  resolved_core_profile_id: number | null;
  resolved_provider: string | null;
  resolved_model: string | null;
};

const credentialName = "(?:proxy[-_ ]?authorization|authorization|(?:x[-_ ]?)?api[-_ ]?key|(?:access|refresh|id)[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|passwd|secret|token)";
const quotedCredential = new RegExp(`("${credentialName}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi");
const assignedCredential = new RegExp(`\\b(${credentialName})(\\s*[=:]\\s*)(?:Bearer\\s+)?[^\\s,;]+`, "gi");

const redact = (value: string): string => value
  .replace(quotedCredential, '$1"[redacted]"')
  .replace(assignedCredential, "$1$2[redacted]")
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]");

const bounded = (value: string | null, limit = MAX_FIELD_BYTES): string | null => {
  if (value === null) return null;
  const safe = redact(value);
  const bytes = Buffer.from(safe);
  if (bytes.byteLength <= limit) return safe;
  return `${bytes.subarray(0, limit).toString("utf8")}\n[truncated]`;
};

/** Builds a deterministic, redacted Run summary for a Core that missed prior work. */
export class ContextHandoffBuilder {
  constructor(private readonly db: Database.Database) {}

  compose(input: {
    sessionId: number;
    targetCoreProfileId: number;
    afterRunId: number | null;
    beforeRunId: number;
    currentInput: string;
  }): string {
    const rows = this.db.prepare(`
      SELECT id, status, input, result, error, resolved_core_profile_id, resolved_provider, resolved_model
      FROM runs
      WHERE session_id = ? AND id > ? AND id < ?
        AND status IN ('succeeded', 'failed', 'cancelled')
      ORDER BY id DESC
    `).all(input.sessionId, input.afterRunId ?? 0, input.beforeRunId) as HandoffRunRow[];
    if (rows.length === 0) return input.currentInput;

    const selected: HandoffRunRow[] = [];
    let used = 0;
    for (const row of rows) {
      const candidate = JSON.stringify({
        runId: row.id,
        status: row.status,
        coreProfileId: row.resolved_core_profile_id,
        provider: row.resolved_provider,
        model: row.resolved_model,
        request: bounded(row.input),
        result: bounded(row.result),
        error: bounded(row.error)
      });
      const bytes = Buffer.byteLength(candidate);
      if (selected.length > 0 && used + bytes > MAX_HANDOFF_BYTES) break;
      selected.push(row);
      used += bytes;
    }
    selected.reverse();
    const firstRunId = selected[0]!.id;
    const lastRunId = selected.at(-1)!.id;
    const handoffId = `session-${input.sessionId}-core-${input.targetCoreProfileId}-runs-${firstRunId}-${lastRunId}`;
    const payload = selected.map((row) => ({
      runId: row.id,
      status: row.status,
      coreProfileId: row.resolved_core_profile_id,
      provider: row.resolved_provider,
      model: row.resolved_model,
      request: bounded(row.input),
      result: bounded(row.result),
      error: bounded(row.error)
    }));
    const omitted = rows.length - selected.length;
    return [
      "[REMOTE_AGENT_HANDOFF v1]",
      `handoff_id: ${handoffId}`,
      `source_run_range: ${firstRunId}-${lastRunId}`,
      ...(omitted === 0 ? [] : [`older_runs_omitted: ${omitted}`]),
      JSON.stringify(payload),
      "[/REMOTE_AGENT_HANDOFF]",
      "",
      "[CURRENT_USER_REQUEST]",
      input.currentInput,
      "[/CURRENT_USER_REQUEST]"
    ].join("\n");
  }
}

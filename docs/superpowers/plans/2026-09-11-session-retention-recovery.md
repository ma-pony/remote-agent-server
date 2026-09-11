# Session retention and recovery implementation plan

> **For agentic workers:** Use the existing TDD and code-review workflow to implement each task in order. The user authorized these corrections after the read-only review. Do not commit, push, or deploy.

**Goal:** Prevent stale expiry decisions, lost cleanup retries, and runnable partially deleted Sessions.

**Architecture:** Keep lifecycle ownership in SessionManager. Recheck retention when claiming storage and persist the maintenance operation before filesystem or runtime side effects. Share transactional completion between normal execution and startup recovery.

**Tech Stack:** Node.js 22, pnpm 10.28.2 through Corepack, TypeScript, SQLite, Vitest.

**Spec:** The three verified review findings in this task and the lifecycle invariants in AGENTS.md; public semantics are documented in docs/design.md and docs/design.en.md.

## Constraints

- Preserve the existing uncommitted restart timestamp correction and unrelated work.
- No new dependencies, real Provider calls, commits, pushes, or deployments.
- Preserve Session metadata, Run history and usage on storage cleanup; permanent deletion removes its existing related records.
- Pending maintenance must block new Runs and must not extend idle retention merely because cleanup retried.

## Task 1: Revalidate expiry at the cleanup claim

Files: src/sessions/session-manager.ts, src/sessions/session-cleanup-scheduler.ts, test/session-cleanup.test.ts.

- [x] Add a deterministic test: pause deletion of expired Session A, complete a Run on expired candidate B, release A, and assert B's storage remains eligible for reuse.
- [x] Run the test against old code and verify the fresh workspace is incorrectly deleted.
- [x] Pass the cutoff to `cleanupStorage(id, cutoff, cleanedAt)` and add `updated_at < ?` to the atomic claim SQL. Skip a candidate that is no longer expired.
- [x] Run the Session cleanup suite.

## Task 2: Retain failed incomplete-creation cleanup

Files: src/sessions/session-manager.ts, test/sessions.test.ts.

- [x] Add a test where workspace removal throws EBUSY once; retain the pending record, then rerun recovery and verify both files and record are removed.
- [x] Verify the old implementation loses the retry record.
- [x] Delete pending Session metadata only after successful workspace deletion. Keep failed creation rollback records pending whenever workspace cleanup itself fails.
- [x] Run Session creation and cleanup tests.

## Task 3: Persist and recover maintenance intent

Files: src/db.ts, src/sessions/session-manager.ts, a shared session-maintenance module, src/main.ts, src/runs/run-repository.ts, and regression tests.

- [x] Add migration and crash-window tests for cleanup, delete and reset; verify failed recovery retains a non-runnable record and can be retried.
- [x] Persist `pending_operation` with values `cleanup`, `delete`, or `reset` in the same transaction that claims the Session.
- [x] Exclude marked operations from generic Run recovery. Reuse transactional completion SQL from normal operations during startup recovery.
- [x] Recover destructive operations before Run scheduling. Failed cleanup/deletion must retain intent and block reuse; do not release partially deleted storage to idle.
- [x] Protect concurrent in-process attempts on one Session. Allow failed pending deletion to be explicitly retried and failed storage cleanup to be retried by the scheduler.
- [x] Verify reset recovery preserves Workspace and Run history while completing context reset.
- [x] Update both READMEs, both design documents and deployment recovery notes.
- [x] Run focused suites, full automated tests, typecheck, production build, and diff checking. Request independent review and resolve actionable findings.

## Verification

- Focused Session, maintenance, database and integration scheduler suites: 80 passed. Run lifecycle and server startup suite: 38 passed.
- Initial full run: 551 passed, 10 skipped, 4 frontend waits failed. The four frontend files passed separately (25 tests).
- Full suite with `corepack pnpm test --maxWorkers=2`: 555 passed, 10 skipped. No test timeouts or frontend code were changed.
- `corepack pnpm typecheck`, `corepack pnpm build`, and `git diff --check` passed.
- Independent review found no confirmed additional defect in the final changes.
- No real Provider smoke tests, commits, pushes, deployments, or live data repair were performed.

# Implementation progress — Agent usage observability

Plan: [implementation plan](2026-09-21-agent-usage-observability.md)

## Current tokenizer replacement

The later [multi-model plan](2026-09-21-model-tokenizers.md) supersedes the historical reference-encoding decisions below. The runtime now uses `@huggingface/tokenizers@0.2.0` with explicit local model/profile bindings. js-tiktoken is removed as a dependency; historical measurements retain their original metadata. Fresh replacement validation and its limits are recorded in the [tokenizer validation report](../validation/2026-09-21-model-tokenizers.md).

## Original-requirements review repair

The later original-requirements audit supersedes the earlier completion checkpoint: manual synthetic snapshot acceptance did not prove automatic model-input capture. It also reproduced crash-before-registration usage loss, unavailable Codex date allocation, MCP events duplicated as CLI and context evidence counted as executions. The user authorized fixing all findings and re-reviewing/testing. Work is tracked in the [repair plan](2026-09-21-agent-usage-review-fixes.md). Earlier test results below are historical, not verification of these repairs.

Repair completion: all actionable task and whole-feature review findings are closed, including interrupted SSE evidence, asynchronous observation capacity, normal waiting UI, tagged/definition-only input drilldown, the SQLite historical parameter ceiling and tied/undated cursor pagination. Fresh full suite: **994 passed, 17 skipped**; typecheck, production build and diff-check passed. Controlled process tests: **56 passed**. Browser acceptance covers automatic HTTP totals, Agent/Session/date filters, MCP/Skill/plugin input evidence and waiting states. No commit, push or deployment. Runtime coverage, test isolation incident and unverified live billing are documented in the [validation report](../validation/2026-09-21-agent-usage-observability.md).

## Decisions

- 2026-09-21 (historical): Work in the requested current project on `codex/agent-usage-observability`, preserving the pre-existing README edits. No commits or live Provider calls are authorized. The user initially approved js-tiktoken@1.0.21; the later tokenizer replacement supersedes this dependency choice.
- Execute the coupled core and host work inline, with focused regression tests and a fresh review once integrated. Keep this record across continuations; do not equate a completed intermediate task with the complete feature.
- Historical initial counter: js-tiktoken lite with local o200k_base ranks, explicitly as estimated reference-encoding counts. Current measurements use the model registry above; the later user correction additionally requires explicitly labeled character-weighted fallback estimates for unknown models.
- Reset failure now retains the maintenance claim until recovery succeeds. Existing behavior reopened the Session even when Provider discard might have partially removed its state; the API regression now checks rejection followed by successful retry.
- Core review corrected empty parent totals erasing detail, unflagged cumulative decreases, residual unplaced totals, source-local identity collisions, and derivation from unknown cache-write values. These are accounting correctness fixes, not additional product scope.

## Interface preflight

| Tasks | Shared contract | Decision |
| --- | --- | --- |
| T0 → T1/T4 | Usage semantics and fixtures | Reported totals and context estimates stay separate; unknown is not zero. |
| T1 → T2/T4 | Source coordinator and binding generations | Core uses opaque IDs; host owns business and path validation. |
| T2 → T4 | Reset/cleanup barrier | Stop producers without discarding, collect bounded source tails, then purge. |
| T3 → T4/T5 | Capability identity and exposure | Stable server/tool identity; skill/plugin tags do not create additive global totals. |
| T4 → T5 | Registration/collect and query | Source management is usable before the standalone CLI. |
| T5 → T6 | UI and public contracts | Management auth, bilingual states, source quality and end-to-end drilldown required. |

## Historical initial status

- T0: Accounting fixture implemented; provider-format fixtures in progress.
- T1: Core and source-coordinator regressions passing (19 tests); integration review and broader verification pending.
- T2: Live Run persistence and maintenance barriers connected; focused host/maintenance tests in progress.
- T4: Independent Codex/Claude log parser implementation delegated to `/root/usage_log_adapters`; check its live status before resuming or reassigning.
- T3, remaining T4, T5–T6: Pending.
- T7: Future extraction, as specified; not part of first-release implementation.

## Verification

Fresh results so far:

- `corepack pnpm exec vitest run test/agent-usage-ledger.test.ts test/agent-usage-sources.test.ts`: 19 passed, after observing the intended red tests.
- `corepack pnpm exec vitest run test/agent-usage-host.test.ts`: 4 passed.
- First combined host/runtime/session run: 135 passed, 1 failure in the old reset-failure contract; updated to the new recovery contract, rerun pending.
- Server TypeScript check passed before the host wiring; rerun after wiring pending.

The design review is not implementation validation. No complete feature claim, full-suite claim or live Provider claim yet.

## 2026-09-21 continuation

- Core scoped re-review passed after per-metric non-overlap selection and cumulative missing-field baseline retention; 17 ledger tests pass.
- Codex/Claude parsers: 9 tests pass; Codex replayable last usage is unknown scope, not a fabricated new request.
- Combined core/host/runtime/session verification previously passed 155 tests; final full suite still pending.
- Explicit file adapters and source management routes now wired into app and startup maintenance recovery. Source API + file tests: 6 passed. Inputs require authorized roots and explicit host mappings; files have a 16 MiB bound and append-only identity checks.
- Context attribution implementation delegated to /root/usage_context using /private/tmp/agent-usage-context-brief.md; check live status before reassigning.
- At that checkpoint, T3 observer, context snapshot adapter, query routes, UI and final docs/verification remained pending; see the later checkpoint below.
- Scoped finding to revisit: SessionCleanupScheduler.stop currently does not await an in-flight cleanup; collector/database shutdown must not race maintenance once the observer is integrated.

## 2026-09-21 naming and integration checkpoint

- User direction: product names must not imply a ContextSpy integration. The independently implemented importer is now Context Snapshot / 上下文快照, source kind `context_snapshot`, envelope `context-snapshot-v1`, parser `parseContextSnapshot`. ContextSpy is retained only as an attributed research reference. No old-name compatibility alias is needed for this unreleased feature.
- Context attribution and tokenizer implementation completed; scoped review closed five accounting/identity findings and 53 focused tests passed.
- Source registration → context snapshot collect → MCP tool ranking → model-input evidence passes synthetic request-level tests. Query routes, local MCP observer and managed Provider log discovery are wired; final integrated review remains pending.
- Frontend task delegated to /root/usage_ui with /private/tmp/agent-usage-ui-brief.md; runtime capability collection remains with /root/usage_runtime_capabilities. Do not duplicate their work.
- Latest server TypeScript check passed. The initial frontend test correctly fails because its page is not implemented yet. Full-suite, process and browser acceptance checks remain pending.

## 2026-09-21 integrated validation checkpoint

- T0–T5 implementation is present. Remaining work is the final consolidated review fix wave, scoped rereview and final verification; T7 remains future extraction.
- Runtime capability review fixed sparse ACP terminal updates leaving Skill/plugin views unfinished. Context-evidence drilldown is separate from counted execution and now uses linked model-input timestamps for date membership. Both integration findings are closed by scoped rereview.
- Source/query/shutdown coverage includes management auth, UTC/IANA/DST boundaries, null metrics, pagination, exact MCP server identity, source collection yields, successive maintenance, waiting for admitted cleanup on shutdown and deletion interleaving.
- Source parser now retains Anthropic system block arrays, avoids counting Chat tool-result contents twice and preserves missing arguments/unknown protocol as incomplete evidence. Legacy Run snapshots are imported independently as unverified evidence, without adding overlapping Session counters.
- Product naming is Context Snapshot throughout source, APIs, UI and fixtures. A generic operator guide and synthetic JSON sample were added; sample verified at 440 reported tokens, 2 estimated first-result tokens and 2 repeated-result tokens.
- Fresh full check: 73 test files passed, 1 skipped; 927 tests passed, 17 skipped, using `corepack pnpm test --maxWorkers=4` outside the sandbox for local listener tests. Full typecheck and production build passed. MCP/ACP process cleanup suite: 56 passed outside the sandbox; sandbox attempt failed because process-table access was denied (`ps: Operation not permitted`).
- Browser production-preview walk uses an in-memory DB and fake Runtime only. Agent/Session/date → MCP Tool → context evidence → first/repeat exposure works. Manual collect exposed a stale collecting state, included in final fixes. No live Provider or external-system smoke run.
- Small synthetic performance observation on Node 22.16.0: importing 1,000 short already-warm-tokenizer contexts took 100 ms; ranking took 30 ms; process RSS was 298 MiB. This is not a production benchmark or a maximum-load guarantee. Parser inputs and tokenizer work remain bounded; source jobs yield between batches.
- Final review required three corrections: canonical Claude runtime identity, collection status polling/refresh, and retaining capability/stage rows when the model ledger is empty. Assigned as one fix wave to /root/usage_final_fixes; brief/report under /private/tmp/agent-usage-final-fixes-*.md. The same wave adds visible per-row context/estimate quality.
- Ruling: first release only exposes `subagents=self` for explicit host mappings and retains no diagnostic bodies — native child-tree identity and encrypted diagnostic retention have no implemented source contract yet; pretending support would misstate coverage. Cost: users needing those optional capabilities must wait for a validated adapter/retention implementation. User-requested host Agent/Session/date analysis remains in scope.

## Final local acceptance — 2026-09-21

- T0–T6: complete within the documented first-release scope. T7 remains the planned future extraction. No commit, push, deployment or live Provider smoke performed.
- Final fix wave unified Claude identity as `claude_code`, added bounded collection polling and terminal refresh, preserved execution-only / catalog-only evidence and exposed per-row estimate/context quality. Focused verification: 4 files, 35 tests passed.
- One scoped final rereview passed all three required P2 corrections and the quality display; no actionable residual. Previous full review and scoped findings are closed.
- Fresh final full suite: 73 files passed, 1 skipped; 936 tests passed, 17 skipped (22.09 seconds). Full typecheck and production build passed. MCP/ACP process suite remains 56 passed; final changes did not touch process ownership.
- Browser on the latest production build confirmed Agent/Session/date → MCP Tool → context exposures, 440 reported tokens and first/repeat result estimates of 2 each; collect refreshes without navigation, and an execution-only Session retains its one-call ranking with unknown model input. The Runtime dropdown contains one Claude option.
- Product code, API source kind, parser, filenames and synthetic fixture use Context Snapshot / `context_snapshot`; third-party project names remain only in research/provenance notes.
- Detailed validation and limitations: [acceptance report](../validation/2026-09-21-agent-usage-observability.md). Operator instructions: [usage guide](../../agent-usage.md).

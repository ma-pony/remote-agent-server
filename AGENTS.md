# AGENTS.md

## Scope

These instructions apply to the entire repository. A more specific `AGENTS.md` or `AGENTS.override.md` may add or override rules for its own subtree.

Use this file for executable repository rules. Use `README.md`, `README.en.md`, and `docs/` for product explanation, architecture detail, deployment procedures, and public contracts.

## Working agreements

- Start by inspecting `git status`, the relevant implementation, nearby tests, and the public contract affected by the task.
- Preserve unrelated working-tree changes. Do not restore, reformat, or rewrite files outside the requested change.
- Follow existing managers, stores, schedulers, routes, components, naming, and test patterns before introducing a new abstraction.
- Fix the root cause with the smallest coherent change. Avoid speculative compatibility branches, one-off frameworks, and abstractions for hypothetical future requirements.
- Keep analysis, review, and diagnosis read-only unless the user also asks for implementation.
- Do not add a production dependency, commit, push, deploy, restart a service, or mutate a live environment without explicit authorization.
- Never expose or commit tokens, Provider credentials, `.env` files, `secret.key`, SQLite data, Provider homes, Session workspaces, or captured runtime payloads.

## Repository map

- `src/agents/`: Agent configuration, model policy, and Agent-scoped limits.
- `src/project-environments/`: repository synchronization, dependency preparation, version publication, and cleanup.
- `src/sessions/`: Session lifecycle, Workspace ownership, reset, deletion, and storage retention.
- `src/runs/`: queueing, concurrency, execution, cancellation, timeout, event persistence, and usage accounting.
- `src/runtime/`: ACP/acpx integration, Provider Session reuse, configuration projection, and process lifecycle.
- `src/mcp/`, `src/skills/`, `src/provider-extensions/`: discovery, Agent selection, validation, and runtime projection of capabilities.
- `src/integrations/`: external Task/Conversation APIs, public event projection, SSE, webhooks, retry, and idempotency.
- `src/settings/`: persisted operational settings exposed by the management API.
- `src/web/`: React management console, shared components, API client, and localization.
- `test/`: Vitest integration, behavior, UI, process-lifecycle, and regression tests.
- `scripts/`: explicit smoke tests that may use real Providers or external services.

## Architecture invariants

- The supported runtime is Node.js 22 as declared in `package.json`; use the repository's pinned pnpm version and package scripts.
- The service is designed as one Fastify process backed by SQLite WAL. Concurrency limits are process-local; do not imply distributed coordination without designing it explicitly.
- The business chain is `Task -> Conversation -> Session -> Run`. A Conversation reuses one Session until it is ended. Each Run remains an independent persisted attempt.
- Runs for the same Session must execute serially because they share a Workspace and Provider conversation. Different Sessions may run concurrently within global and Agent limits.
- A Run timeout starts when execution begins, not while it is queued. Queue state and running state must remain distinguishable in APIs, UI, recovery, and metrics.
- A Session owns an isolated writable Workspace. macOS uses APFS clones and Linux uses Btrfs snapshots; do not add a silent full-directory-copy fallback.
- Project-environment publication is atomic: a failed build must not replace the last usable version. A Session keeps using the version from which its Workspace was created.
- Provider Sessions should be resumed when supported. Resetting Provider context must not silently delete the business Session, Workspace, Run history, or usage statistics.
- Configuration changes to Skills, Provider extensions, MCP, or model policy take effect on a later Run. Do not interrupt an active Run to apply them.
- Model schedules are evaluated in UTC when a queued Run actually starts. Persist the resolved model on the Run when the Core exposes one.
- Runtime shutdown must terminate the complete ACP, MCP, checker, browser, and wrapper process trees on success, failure, cancellation, timeout, reset, idle eviction, and server shutdown. A child process surviving its owner is a correctness bug.
- Session storage cleanup removes large runtime artifacts and Task-linked Webhook deliveries only after the Session is idle. It must preserve Session/Run metadata, Task/Conversation records, and token statistics. A separate raw-event retention policy may retire completed Run message/tool bodies only after counting and vocabulary backfill complete; preserve final replies, status/error events, expiry markers, and monotonically increasing event sequences.
- Internal events may contain privileged data. Public integration events must stay an explicit allowlisted projection; never forward raw tool input/output, thoughts, secrets, or Provider-private fields.
- Persisted state transitions that span multiple records must be transactional or idempotently recoverable after a process restart.

## Backend implementation

- Validate external input at the route boundary with the existing Zod and route patterns. Keep routes focused on authentication, validation, delegation, and response mapping.
- Put business transitions in the existing manager, coordinator, scheduler, executor, or store responsible for that lifecycle. Do not duplicate lifecycle rules in a route or UI component.
- Reuse database transactions for related writes. Define stable idempotency keys for retried integration and webhook operations.
- Use existing bounded-operation, scheduler, and process-management utilities for long-running work. Do not block the Node.js event loop with synchronous polling or unbounded computation.
- Preserve typed error codes and the established management/public API shape. Do not leak raw exception messages across a public boundary when a mapped error exists.
- Encrypt sensitive persisted values through the existing secret store and return only redacted management projections.
- When changing a lifecycle, inspect every terminal path: success, validation failure, runtime failure, cancellation, timeout, restart recovery, reset, deletion, and idle cleanup. Only implement paths relevant to the change, but do not leave resources or persisted state inconsistent.

## Frontend components and styling

Changes under `src/web/` must reuse the existing design system.

Use this order before creating UI:

1. Reuse a product component from `src/web/components/`.
2. Reuse a primitive from `src/web/components/ui/`.
3. Compose installed shadcn/Radix and Lucide capabilities.
4. Add an official compatible shadcn/Radix primitive when the repository genuinely lacks it.
5. Create a small custom component only when the previous options cannot express the interaction accessibly.

Additional rules:

- Do not hand-roll buttons, inputs, selects, dialogs, confirmation flows, cards, alerts, badges, tabs, tooltips, sheets, form fields, loading states, or icons that already exist.
- Put generic primitives in `src/web/components/ui/`, reusable product components in `src/web/components/`, and page-specific composition and data flow in page files.
- Use Tailwind utilities, component variants, `cn`, and the semantic variables in `src/web/styles.css`. Do not introduce a parallel palette, arbitrary visual language, or repeated inline styles.
- Match existing spacing, typography, density, radius, responsive behavior, focus treatment, and dark-mode support.
- Every asynchronous screen needs intentional loading, empty, error, success, disabled, and destructive-confirmation states where applicable.
- Preserve keyboard operation, visible focus, accessible names, labels, and appropriate `aria-*` state.
- Route all user-facing copy through the existing Chinese/English `text(...)` pattern.
- Add interaction tests for meaningful selection, validation, confirmation, disabled, and error behavior.

## Tests and verification

Use the narrowest test that proves the changed contract, then expand verification according to risk.

- Focused test: `pnpm exec vitest run test/<relevant-file>.test.ts`
- Full automated tests: `pnpm test`
- Server, web, and script type checking: `pnpm typecheck`
- Production compilation: `pnpm build`
- Real MCP/acpx process cleanup: `pnpm test:mcp-process`
- Real Provider and integration smoke tests: `pnpm smoke:providers` and `pnpm smoke:integrations`

Testing expectations:

- Add a regression test for behavior changes and bug fixes when the behavior is automatable.
- Prefer request-level tests for API changes so authentication, validation, serialization, persistence, and error mapping run through the real boundary.
- Test queue, retry, timeout, cancellation, restart, and cleanup behavior with deterministic fakes unless the bug depends on a real process tree.
- Use Testing Library interactions for web behavior; assert user-visible state rather than component internals.
- Run process and smoke suites only when relevant. Smoke tests require explicit authorization because they may start real Providers, use credentials, or call external systems.
- Documentation-only changes require at least `git diff --check`; they do not require an unrelated full build.
- Do not claim a test, build, smoke check, deployment, or live fix succeeded without fresh command output from the current worktree or target environment.

## Documentation and public contracts

- Update both `README.md` and `README.en.md` when user-facing behavior, setup, configuration, or operator workflow changes.
- Update `docs/design.md` and `docs/design.en.md` when architecture, lifecycle semantics, persistence, concurrency, or security boundaries change.
- Update `docs/deployment.md` for host prerequisites, environment variables, service management, backup, restore, or upgrade steps.
- Keep examples generic. Do not add organization-specific hosts, credentials, Agent names, ticket IDs, or private service assumptions to reusable docs or fixtures.
- Treat API payloads, persisted configuration, webhook signatures, event ordering, error codes, and CLI-visible behavior as contracts. Update tests and documentation with the implementation.

## Code review rules

Review for behavioral regressions before style issues. Pay particular attention to:

- Session/Conversation reuse and per-Session serialization;
- queue admission, concurrency accounting, timeout start points, and restart recovery;
- duplicate dispatch, webhook idempotency, and persisted state ordering;
- Provider Session continuity and model-policy resolution;
- ACP/MCP/browser subprocess ownership and cleanup;
- Workspace snapshot lifetime, environment publication, and storage reclamation;
- secret redaction and public event/API projection;
- management UI states that can misrepresent queued, running, completed, or failed work.

Keep findings specific: identify the broken contract, the reachable scenario, the impact, and the smallest safe correction.

## Completion checklist

Before handing off a change:

1. Inspect the final diff and confirm unrelated changes were preserved.
2. Run the relevant focused tests and broader checks proportionate to risk.
3. Check formatting with `git diff --check`.
4. Update public documentation when the contract changed.
5. Report changed behavior, verification performed, and any check not run or remaining operational step.

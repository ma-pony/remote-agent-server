# Skill sources and updates implementation plan

**Goal:** Implement the approved manual source, version preview, Agent apply and rollback workflow.

**Architecture:** Git source adapters publish immutable package snapshots. SkillManager owns Agent selection and revision history; SkillProjector projects complete packages to Session-owned directories; existing runtime fingerprints refresh reused connections. Existing management authentication protects all new routes.

**Tech stack:** Node.js 22, TypeScript, filesystem, existing bounded subprocess utility, Fastify/Zod, React/shadcn, Vitest. No production dependencies.

**Spec:** [Approved design](../specs/2026-09-14-skill-source-updates-design.md)

## Global constraints

Preserve unrelated changes; no commit, push, deployment, real Provider smoke tests or live source installation. No execution of marketplace commands/hooks. No credentials in API responses. Refresh cannot change existing Agent selections or active Runs. Paths and archives are bounded and validated. Use existing UI and bilingual documentation patterns.

### Task 1: Source discovery and snapshots

Implement `src/skills/skill-source-manager.ts` with the adapter contract in the spec. Support ordinary repositories, `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`, portable and legacy plugin metadata, local marketplace paths and Git/GitHub/git-subdir plugin sources. Report unsupported entries. Reuse bounded process tree termination. Test deterministic checkout fixtures, stable IDs, ref/commit propagation, failed refresh preservation, traversal/symlink rejection, concurrency and shutdown. Never modify SkillManager, projector, routes or web files in this task.

### Task 2: Versioned selection and projection

Introduce shared Skill metadata/content helpers. Extend SkillManager with content revisions, complete package snapshots, idempotent enable, optimistic apply, bounded diffs, rollback and same-name replacement ZIP publishing. Preserve old directory installations and uploaded catalogs. Project selected packages into Session-owned storage with managed links and content fingerprints. Record projected digest on Runs. Cover script-only edits, isolated Agent selections, stale writes, rollback, local modifications and projection failure recovery.

### Task 3: Hermes Session isolation

Move Hermes homes/Skills to `data/agents/<agent>/provider-home/hermes/sessions/<session>`. Preserve legacy Hermes provider history when first creating an isolated home; never recursively copy the sessions directory. Cleanup deletes only the target Session home and applicable legacy conversation files. Cover two concurrent Session homes, resume and storage cleanup. Do not modify SkillManager, SkillProjector or RunExecutor; coordinate the exact projection path with Task 2.

### Task 4: Management routes and UI

Register shared source routes and version APIs under current authentication with strict schemas and safe typed error mapping. Add the shared source dialog and revision preview/apply/rollback in the Agent Skills page using existing primitives. Test request validation/authentication/error mapping and user-visible interactions including pending/error/disabled states.

### Task 5: Review and verification

Update README.md, README.en.md, docs/design.md, docs/design.en.md and deployment Git/auth/storage prerequisites. Run focused tests, complete automated suite with bounded worker count, typecheck, build, diff check. Independently review the final diff, address reachable regressions, and report any unverified operational steps. Do not commit or push without new authorization.

## Delivery verification — 2026-09-14

All five tasks are implemented. Independent review findings about Claude marketplace paths and Hermes legacy parent-state retention were addressed and re-reviewed. Additional regression coverage verifies linked installation migration, selected-name conflicts, and preserved source catalog counts.

- Full automated suite: 54 files passed, 1 skipped; 662 tests passed, 10 skipped.
- After the final source-count correction: source manager, management API and Skill UI suites passed all 28 tests.
- Final typecheck, production build and `git diff --check` passed. No production dependencies changed.
- Real remote Git source access and real Provider smoke tests were unverified at the implementation handoff. The subsequent user-requested acceptance run is recorded in [the test report](../validation/2026-09-14-skill-source-updates.md).
- The user subsequently authorized documentation updates, committing, and pushing to `main`. Public documentation now distinguishes verified Skill behavior, Provider environment blockers, and the unresolved upstream error-status propagation issue. Deployment is outside this delivery.

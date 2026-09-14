# Skill sources and manual updates

Approved scope: add Git sources for ordinary Skill repositories and Claude/Codex plugin marketplaces. Discover versions separately from applying them to an Agent. Keep whole package contents, preview changes, allow rollback, and apply configuration on subsequent Runs.

## Boundaries

- This is Skill distribution. Marketplace hooks, MCP servers, dependencies and install commands are not executed. Unsupported catalog entries are reported explicitly.
- GitHub and GitLab use the same Git transport. Accept HTTPS/SSH URLs and SSH scp syntax; reject embedded HTTP credentials and local/file/ext transports. Reuse host Git credentials without copying them into source records.
- Manual refresh only. A failed refresh keeps the last usable catalog. No automatic Agent upgrades.
- Filesystem storage follows the existing Skill manager. Source snapshots and Skill package revisions are immutable; publish catalogs and installed links atomically. Keep prior revisions for rollback.
- Stable identity derives from configured source + plugin identity + Skill path, never a cache version directory. A digest covers the entire package, including scripts, references and executable permissions.
- Agent selections use private copies of package revisions during runtime projection. Each Skill resolves its supporting package from one revision. Different Agents can select different revisions.
- Updating an enabled Skill requires the expected installed digest; changed local content must be preserved and reported as a conflict. Enabling an already enabled Skill is idempotent.
- Hermes provider homes and managed Skills become Session scoped. Existing durable conversations need migration into the isolated home before resume. Active Runs retain their projection.
- Persist the projected revision on each Run for audit. Existing Runs may have no recorded revision.

## Source adapter contract

`SkillSourceManager({ dataDir, checkout? })` exposes `list()`, `add({name,url,ref?,path?})`, `refresh(id)`, `remove(id)`, `catalog()` and asynchronous `close()`.

`catalog()` returns entries with `id`, `name`, `description`, `directory` (the Skill directory), `packageDirectory` (complete package), `skillPath` (relative to package), `sourceId`, `packageName`, `repositoryUrl`, `ref`, `commit`, and `revision` (content digest).

Sources expose `id`, `name`, `url`, `ref` (nullable), `path`, `status` (`ready`, `syncing`, `failed`), `lastSyncedAt` (nullable), `error` (safe code or null), `skillCount`, and `warnings` (safe human readable descriptions). Catalog readers never observe a partially refreshed source. Bound operations, abort subprocess trees at shutdown, and clean staging directories after failure/restart.

## Management contract

- `GET/POST /api/skill-sources`; `POST /api/skill-sources/:id/refresh`; `DELETE /api/skill-sources/:id`.
- Agent Skills retain existing fields and add optional `sourceId`, `packageName`, `currentRevision`, `latestRevision`, `updateAvailable`, `locallyModified`.
- `GET /api/agents/:id/skills/:skillId/revisions` returns current/latest digests plus available revision metadata.
- `GET /api/agents/:id/skills/:skillId/diff?revision=<digest>` previews changed files against the installed version. Text previews are bounded; binary/large files retain change status and executable permission metadata.
- `POST /api/agents/:id/skills/:skillId/revision` applies `{revision, expectedRevision}` only to this Agent, including historical revisions.
- `POST /api/agents/:id/skills/:skillId/upload` publishes a replacement ZIP with the same Skill name; the Agent applies it explicitly.
- Source removal removes discovery, preserves installed revisions and rollback history. Only shared uploaded Skills retain the existing global delete operation.

## Operator experience

The Agent Skills page offers shared source management, refresh/error/unsupported-entry feedback, version badges, a file change preview, explicit apply and rollback, and same-name ZIP version publishing. Copy states that source refresh only discovers versions and applying affects subsequent Runs. Chinese and English use the existing design system.

## References

- https://code.claude.com/docs/en/plugin-marketplaces
- https://developers.openai.com/plugins/build/plugins
- https://github.com/vercel-labs/skills

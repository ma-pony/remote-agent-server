# Message attachments implementation plan

**Goal:** Accept images and ordinary files from the management console and HTTP integration API.

**Design:** Keep existing text fields and add optional `attachments: [{name, mediaType, data}]` with canonical base64 bytes. Persist bounded attachment payloads separately from history in SQLite, atomically with their Task/Run. Pass supported raster images through native ACP image blocks; materialize all files in a fresh Session workspace directory and include file references in the runtime prompt. History exposes metadata and authenticated downloads. Session cleanup removes payloads while preserving metadata.

**Constraints:** Node.js 22, pnpm 10.28.2, existing UI components, bilingual copy, no new dependencies. Maximum 8 attachments, 10 MiB per file, 20 MiB total; native images PNG/JPEG/GIF/WebP at most 5 MiB each. Other formats remain ordinary files.

## Steps

- [x] Add failing request-level tests for attachment-only Runs and integration submissions, retrieval/authentication, idempotency, and runtime delivery.
- [x] Add shared attachment validation/types/store, schema migration, Task-to-Run linking, metadata projection, and cleanup.
- [x] Materialize files safely inside Session workspaces and forward native image content to acpx; test transaction rollback and lifecycle behavior.
- [x] Add reusable upload/paste/remove/preview UI and authenticated history downloads to Session and integration test flows; test interactions.
- [x] Update Chinese/English README and design docs plus deployment limits; run focused tests, full tests, typecheck, build, and diff check; review final change.

## Validation coverage

- Request-level tests cover submission, validation, authentication, metadata, downloads, and idempotency.
- Runtime tests cover native image delivery and workspace file preparation.
- Browser interactions cover selection, image preview, removal, failed-submission drafts, and downloads.
- Lifecycle tests cover persistence across restart, per-Session cleanup isolation, interrupted maintenance recovery, retained history, and cascading deletion.

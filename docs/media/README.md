# README screenshots and demo recordings

These assets show the actual Remote Agent Server management console, built from commit `e919d65` on 2026-09-18. The `zh` and `en` variants use the corresponding UI language and translated sample content.

| Asset | What it shows |
| --- | --- |
| `integration-{zh,en}.png` | Endpoint usage, request parameters, and the test task form. |
| `task-{zh,en}.png` | A completed business task, its reply, and linked resources. |
| `session-{zh,en}.png` | The linked session with its message and tool-event history. |
| `business-workflow-{zh,en}.gif` | A short, captioned preview for GitHub README rendering. |
| `business-workflow-{zh,en}.mp4` | The same walkthrough as a pausable video. |

## Recording conditions

- Chromium, 1440 × 1000 viewport, the product's default theme, and no personal browser profile.
- Two isolated loopback instances of the real `buildApp`, each with an in-memory database and temporary directories.
- Generic, synthetic ticket data. The `AgentRuntime` and workspace adapter are test fixtures. Tool events and agent replies are simulated; no Provider CLI, model, real repository, or business system is invoked.
- Tasks are submitted through the real public Task API and flow through the application's scheduler, persistence, and management UI. The video then opens the linked session; it does not submit a follow-up message.
- Callback delivery is disabled. The recordings do not demonstrate real model performance, filesystem snapshot behavior, or webhook delivery.
- Screenshots are captured directly from the UI after loading. Video captions are added in a separate band above the original viewport. Durations are illustrative and are not a benchmark.
- No API tokens, Provider credentials, private paths, or real runtime payloads are included in these assets.

## Updating the assets

Build the current application with the pinned pnpm version. Use disposable data and a deterministic runtime, following the dependency-injection pattern in `test/integration-api.test.ts`; never capture a live business environment for these examples. Capture the endpoint usage, completed task, and loaded session pages in both languages. Record a fresh API submission and follow its task into the linked session.

Check the exported images and the beginning, transitions, and end of each video. Keep the fixture disclosure in both READMEs and in the video captions. Keep the original interface intact, and update this provenance note when the UI or sample workflow changes.

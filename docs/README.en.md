# Documentation

[简体中文](README.md) · [Project home](../README.en.md)

Choose a guide for your current task. For a first installation, complete one task in the console before connecting a business application.

| Your task | Guide | Covers |
| --- | --- | --- |
| Understand the project and run your first task | [Overview and quick start](../README.en.md) | Use cases, requirements, console workflow, and HTTP integration examples. |
| Deploy, upgrade, or recover the service | [Deployment and acceptance (Chinese)](deployment.md) | APFS/Btrfs, service management, task and integration checks, backups, and storage cleanup. |
| Track tokens or analyze capability usage | [Usage and collection (Chinese)](agent-usage.md) | Reported usage versus estimates, collection sources, historical backfill, and retention. |
| Understand the current architecture | [Product and architecture](design.en.md) | Object relationships, session reuse, queues, concurrency, workspace lifecycle, and security boundaries. |
| Discuss future multi-Core routing | [Agent Core routing proposal](agent-core-routing.en.md) | A proposed design and staged plan that has not been implemented. |

## Find a feature

| Feature | Instructions |
| --- | --- |
| Duplicate agents and supply project or environment values | [Configurations and session parameters](../README.en.md#reuse-configurations-and-session-parameters) |
| Reset provider context while keeping the workspace | [Rebuild a provider session](../README.en.md#rebuild-a-provider-session) |
| Control tools and Skill revisions | [MCP tool selection](../README.en.md#mcp-select-tools-per-agent), [Skills from Git](../README.en.md#skills-install-and-update-from-git) |
| Schedule models and concurrency | [Model policies](../README.en.md#model-policy-quick-reference) |
| Track tokens, daily averages, and session trends | [Dashboard metrics (Chinese)](agent-usage.md#用量看板) |
| Upgrade, restore, and manage database space | [Backups and recovery (Chinese)](deployment.md#8-升级备份与恢复), [Usage data maintenance (Chinese)](deployment.md#用量数据保留与维护) |

## Key terms

| Term | Meaning in this project |
| --- | --- |
| Agent | Execution configuration: provider, project environment, instructions, Skills, MCP, and model policy. |
| Provider | Claude Code, Codex, Hermes, or DeepSeek Harness, which performs the task. |
| Session | An agent conversation with its own workspace that can run multiple turns. |
| Run | One input and its execution within a session. Queued and running are distinct states. |
| Conversation | An external multi-turn business conversation that reuses one Session until it ends. |
| Task | One asynchronous request submitted by an external system. |

## Current behavior and proposals

The README, deployment guide, usage guide, and architecture document describe the current implementation. The Agent Core routing document is explicitly labeled as an unimplemented proposal.

`superpowers/specs/`, `superpowers/plans/`, and `superpowers/validation/` contain dated designs, implementation plans, and validation records. Check their date and version when reading them; historical validation does not establish production acceptance for the current version.

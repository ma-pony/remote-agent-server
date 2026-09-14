# Skills 来源和版本更新测试记录

测试日期：2026-09-14。分支：`codex/skill-source-updates`。使用 Node.js 22.16.0 和仓库锁定的依赖。本次使用临时目录、临时 Provider Home 和测试资源，没有操作业务 Agent、已有会话或线上服务。

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `pnpm test --maxWorkers=4` | 54 个文件通过、1 个跳过；662 项测试通过、10 项跳过 |
| `pnpm test:mcp-process --maxWorkers=4` | 3 个文件、48 项测试通过，覆盖实际 ACP/MCP 测试进程回收 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `git diff --check` | 通过 |

自动化覆盖来源失败保留、manifest 路径规则、版本差异、Agent 独立选择、过期写入拒绝、本地修改保护、ZIP 新版发布、回退、Session 投影隔离、Hermes 历史迁移和管理界面交互。

提交前复验暴露了 UI 测试的准备时机问题：Skills、MCP、外部接入的首个用例可能在首次 React.lazy 路由转换时超过 Testing Library 的 1 秒等待时间；并行构建会加重该现象，单独测试也曾复现。修正这三个测试文件的 `beforeAll`，先导入真实页面模块，把模块转换移到测试准备阶段。应用、路由、请求、全部业务断言及其等待时间均保持原样，没有添加重试或固定延迟。修正后相关三个测试文件的 39 项用例通过，并重新验证完整测试。

## 真实 Git 来源

使用真实 `SkillSourceManager` 默认 Git checkout，不注入替身，不执行远端仓库中的脚本。对非空目录启用一个 Skill，确认 `SKILL.md` 投影可读；再次刷新确认 Agent 仍保留原选择；移除来源后确认已启用副本保留。

| 来源 | 实际 commit | 结果 |
| --- | --- | --- |
| [openai/skills](https://github.com/openai/skills)，子目录 `skills/.system/skill-creator` | `49f948faa9258a0c61caceaf225e179651397431` | 发现 1 个 Skill，导入、投影、刷新和保留验证通过 |
| [anthropics/skills](https://github.com/anthropics/skills) | `34040c9c568585f6929bedeaad110ad08f079624` | Claude marketplace 发现 19 个 Skill，无警告，验证通过 |
| [openai/plugins](https://github.com/openai/plugins) | `1dc195897af4161d039b80d8471ec0a10c9bbc89` | Codex marketplace 发现 524 个 Skill，无警告，验证通过 |
| [GitLab Git 测试仓库](https://gitlab.com/gitlab-org/gitlab-test) | 未记录 | 拉取并刷新成功；该仓库没有 Skill，仅验证 GitLab 传输，不计为非空 Skill 导入验收 |

## 真实 Provider

直接调用真实 `AcpxAgentRuntime`，以随机值作为 Skill 的 `references/value.txt` 内容。每一轮都要求 Provider 通过工具重新读取资源；同时核对最终值和 Provider Session ID，不能仅凭 Run 状态判定成功。使用临时配置关闭个人 Hook/MCP，只发送测试文本。

| Provider | 结果 |
| --- | --- |
| Codex，临时指定 `gpt-5.5` | 3 轮通过：初始读取、只修改资源文件后的应用、回退。每轮观察到工具调用，实际内容匹配；更新和回退后 Provider Session ID 均保持一致 |
| Claude Code | 未通过验收：隔离测试最初报 `Authentication required`；显式加载现有认证环境后，上游返回 HTTP 403 `MODEL_ACCESS_DENIED`，未进入 Skill 读取 |
| Hermes | 未通过验收：本机配置的模型服务对 `gpt-5.5` 返回 HTTP 503，提示没有可用通道，未进入 Skill 读取 |

Codex 原配置中的 `gpt-6-astra` 也未通过：仓库的 `@agentclientprotocol/codex-acp@1.1.14` 所带 `codex-cli 0.147.0` 收到“模型需要更新版本 Codex”的 HTTP 400。仅在临时测试 Session 改用账户模型列表中的 `gpt-5.5`，没有修改用户配置或升级依赖。

另一个待处理的运行时问题：上述 Codex 400 和 Hermes 503 被上层适配器作为输出文本返回，同时 `RuntimeTurnResult.status` 为 `completed`。因此完成状态不能代表模型调用成功。本次按实际输出和工具调用判断，未将这些错误运行计为通过；该错误状态传递问题尚未修复。

所有临时来源、Provider Home、测试会话与资源均已清理。结束后只读进程检查发现 0 个匹配本次临时 Provider 目录的残留进程。本记录生成于主分支交付前；本次测试未部署服务。

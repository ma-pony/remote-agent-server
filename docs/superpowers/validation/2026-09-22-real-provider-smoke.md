# Codex / Claude Code 真实 Provider 烟测

日期：2026-09-22。被测提交：`17d3e705c11f13537594f43720baab49f693a184`。

## 结论

**部分通过，不能认定完整用量功能已完成真实 Provider 验收。**

- Codex 使用 `gpt-5.5` 完成真实双轮会话、文件读取、MCP 调用、事件持久化、Agent/Session 总量查询以及 Reset 保留统计。
- Codex 当前宿主默认模型 `gpt-6-astra` 与项目内置 CLI `0.147.0` 不兼容。上游返回 400，但该次 Run 被标记为 `succeeded`；实际回复校验正确判定失败。
- Claude Code 的网关拒绝模型访问，返回 `403 MODEL_ACCESS_DENIED`。原生 CLI 的最小短回复探针也失败，因此未取得成功响应，未完成其双轮及自动输入归因验收。
- Claude 失败路径两次出现 Runtime 关闭失败，其中最后一次记录为 `handle_close`。最终复核记录的测试进程均已退出，但正常关闭合同仍不能判为通过。

## 方法与范围

使用当前源码启动临时独立 Fastify 实例、SQLite 数据库和真实 APFS Workspace。通过真实 HTTP 管理 API 准备本地合成 Git 项目、Agent、Skill、stdio MCP、Session 和 Run。没有修改已有服务、原始 Provider 配置或业务数据；按要求只测试 Codex 与 Claude Code。

临时验收驱动复用了 `scripts/smoke-providers.ts` 的 HTTP 客户端、Run 轮询和事件序列断言，并增加以下检查：

1. 首轮读取启用的测试 Skill，用 Shell 读取 Workspace 中的随机标记，再调用 `usage_smoke.lookup_token` 取得另一个标记。
2. 核对真实结果包含两个预期标记与实际工作目录名。Run 结果包含过程说明时，按最终结果核对，不把过程说明误判为模型失败。
3. 第二轮不使用工具，复述上一轮结果；验证 Provider Session ID 未改变，两个 Run 的事件序号从 1 连续递增。
4. 查询 Session、Agent、UTC 日期、MCP、CLI、Skill 和插件维度，再 Reset 检查历史总量保留。
5. 关闭实例，复查测试 PID，并移除临时 Provider Home 和凭据副本。

MCP 服务及项目文件是本地合成测试输入；Provider、ACP、模型请求、HTTP API、SQLite 持久化和 APFS 隔离均是真实路径。没有运行 Hermes，也没有将本轮结果等同于前端浏览器验收。

## Codex 结果

项目内置 `@agentclientprotocol/codex-acp` 为 `1.1.14`，其 Codex CLI 为 `0.147.0`。全局 `codex` 命令另有缺失可选平台包的问题；本项目实际调用内置 CLI，因此成功测试不依赖全局命令。

默认 `gpt-6-astra` 请求收到明确错误：该模型要求更新的 Codex 客户端。保留该失败结论后，从 ACP 实际公开的模型目录中选择 `gpt-5.5`，只调整临时测试 Agent 的模型策略进行补测。

成功测试使用 Session 1、Run 1/2（均属于独立临时数据库），模型实际返回正确文件/MCP 标记，第二轮结果一致，Provider Session ID 保持一致。MCP 上游调用日志和管理 API 均显示 `lookup_token` 调用一次。

| 指标 | 实际结果 |
| --- | ---: |
| Session 总 tokens | 72,843 |
| 输入 tokens | 72,540 |
| 其中缓存读取 tokens | 54,144 |
| 输出 tokens | 303 |
| UTC 日期桶内总 tokens | 59,100 |
| 未能归入时间桶的总 tokens | 13,743 |
| Agent 总量 | 72,843 |
| Reset 后总量 | 72,843 |
| `lookup_token` 实际调用次数 | 1 |

日桶与未归位部分之和为 72,843。当前累计日志适配器不能为首个累计观测推导完整时间区间，因此保留未归位值并标记 `partial`，不能把日期桶单独当作完整总量。

Codex 使用 OAuth。当前 HTTP 自动采集不覆盖该认证模式，所以本次 MCP/CLI 排名验证了执行次数，`totalInputTokens` 为 `null`。Skill/插件 token 排名没有得到成功的真实输入证据，不能宣称已通过逐工具 token 归因验收。未知模型分词兜底不能替代不存在的上下文输入证据。

## Claude Code 结果

使用现有网关凭据，在临时配置中启用 Messages HTTP 自动采集。网关同一主机的 HTTPS 入口可连接。没有打印或写入仓库任何凭据。

首次实际模型请求为 `claude-opus-4-8`，返回 `403 MODEL_ACCESS_DENIED`。虽然宿主配置的模型别名指向自定义模型，仅设置临时 `settings.model` 后，实际请求仍使用上述 Claude 模型。将自定义模型加入临时 `availableModels` 后，管理 API 模型目录返回 HTTP 500、ACP `-32603 Internal error`，该尝试没有继续发起 Run。

为区分网关问题和采集/ACP 问题，又使用本机 Claude Code `2.1.208`、现有配置的 `deepseek-v4-pro` 做了一次独立原生命令探针：禁用 MCP，并明确要求不使用工具、只回复固定短文本。原生命令同样返回 `403 MODEL_ACCESS_DENIED`、退出码 1，所有 token 指标为 0。

这证明当前配置至少存在上游模型访问阻碍，不能仅靠更换本项目采集配置获得成功响应。没有尝试更换账号、绕过模型权限或安装/升级 Provider。

自动采集记录了失败请求，并显示 `upstream_status`、`unsupported_endpoint`；没有将失败请求伪造为成功用量。此处只验证了失败采集路径，不代表正常模型响应、MCP 输入排名或 Skill/插件输入归因通过。

## 尚未通过的合同与后续处理

1. **上游模型错误的 Run 状态传播**：Codex 的 HTTP 400 作为文本返回后，Run 仍是 `succeeded`。这是已有文档所述限制的真实复现；必须检查实际回复，不能只看终态。
2. **默认模型与客户端兼容性**：ACP 公开目录包含 `gpt-6-astra`，但内置 CLI 无法实际使用；目录可见不等于执行可用。
3. **Claude 模型访问与自定义模型目录**：现有模型被网关拒绝，临时自定义模型列表还触发 ACP 初始化错误。需要可访问的模型配置后才能补齐正常响应验收。
4. **Claude 失败后的关闭行为**：失败请求后关闭独立实例，两次收到 Runtime 关闭错误。最后一次失败现场记录为 Session 2 的 `handle_close` 失败；最终 PID 复核未发现记录的测试进程仍在运行，但关闭返回错误仍应处理。
5. **逐工具输入 token 真实覆盖**：Codex OAuth 只有累计用量和执行事实；Claude 成功请求被上游阻断。因此具体 MCP/Skill/插件输入 token 排名仍需成功的可采集 Provider 请求验证。

本轮只执行烟测和诊断，没有修改生产代码、依赖、宿主 Provider 配置，也没有提交、推送或部署新变更。临时驱动、脱敏 JSON 结果和 SQLite 证据留在本地临时目录，原始 Provider Home、登录副本及其运行日志已清理。README 原有未提交改动保留。

# Agent 用量分析首版验收

日期：2026-09-21。分支：`codex/agent-usage-observability`。本报告验证当前工作区的离线实现，不代表已提交、部署或完成真实 Provider 验收。

> 后续原始需求审查发现自动上下文采集、首次登记前退出恢复、Codex 日期归属及工具分类缺口。下文“原实现历史验证”的结果为修复前记录，不能证明这些场景通过。修复与重新验收见[修复计划](../plans/2026-09-21-agent-usage-review-fixes.md)。

## 原始需求修复验收

以下为本次修复后的新结果，下方 936 个测试仅为修复前记录。

- 全量测试：`rtk proxy corepack pnpm test --maxWorkers=4`，75 个文件通过、1 个跳过；**994 个测试通过、17 个跳过**，耗时 26.68 秒。
- `rtk proxy corepack pnpm typecheck`、`rtk proxy corepack pnpm build`、`rtk proxy git diff --check` 通过；Vite 构建 2,082 个模块。
- 本机合成进程测试：`rtk proxy corepack pnpm test:mcp-process`，3 个文件、56 个测试通过。
- Task 1 独立复审关闭恢复积压、关闭尾部采集、日期重叠、区间边界和阻塞就绪问题，以及恢复状态刷新问题。
- Task 2 独立复审关闭异步观察额度、中断 SSE 证据丢失、启动顺序、SSE 定时器所有权和正常等待误报问题；定向验证 9 个文件、199 个测试通过。
- 最终整体审查发现的两处 P2（标签／仅定义输入证据不可下钻、历史上下文触发 SQLite 参数上限）均已修复。修复复审额外发现的同时间记录分页漏项也已修复；有时间／无时间两组各 32 条记录逐页恰好出现一次。最终独立复审通过，没有遗留的本次审查必修项。

| 原始需求或审查问题 | 验收标准 |
| --- | --- |
| 总量偏小、超过 100 条记录、Reset 后丢失 | 历史账本不受运行时窗口影响；同一来源重放不重复；Reset 保留历史 |
| 首次来源登记前退出、超过一批的恢复积压 | 启动自动发现并持续补采；失败可重试；不阻塞服务就绪 |
| 关闭时最后一段日志遗漏 | 停止生产者后补采本次实际 Session，不被历史批次上限截断 |
| Agent／Session／日期统计 | 共用查询口径；日期使用真实请求时间或可信区间；无法定位的部分单列 |
| 自动模型输入与具体 MCP 排名 | 受控 HTTP 流量经实际 Runtime 启动配置进入采集器，无需手工快照；可查询定义、首次和重复结果输入 |
| MCP／CLI／Skill／插件区分 | 结构化 MCP 不落入 CLI；同名不同 Server 分开；Skill／插件按逐调用路径证据归属 |
| 原生日志与捕获同时存在 | 同身份去重；日期只选择一个来源依据；累计父范围保留总量与未定位余量 |
| 执行次数与上下文证据 | `calls` 只计执行，`contextOnlyCalls` 单列；日期过滤不改变语义 |
| 会话复用、Reset、删除与迟到请求 | 第二次 Run 使用正确绑定；epoch／generation 隔离；删除后不能重新写入 |
| 透明转发、凭据及正文隐私 | SSE／压缩字节保持；仅服务持有真实上游 key；新 SQLite 表不留正文或凭据 |
| 用户可见采集状态 | 等待、采集中、失败、恢复完成明确区分；页面自动刷新恢复结果 |

受控协议用例覆盖 Responses、Chat Completions、Anthropic Messages、分片 UTF-8/SSE、压缩副本解析、真实 socket 中断、截断末帧、响应原字节透传、密钥替换和超限降级。Codex 与 Claude 的 fake Provider 实际读取生成的启动环境／配置并访问 loopback 上游，复用后的第二 Run 归属也已验证。累计 190 与完整捕获 190 的日期统计为 190；部分捕获 70 时，未定位余量为 120，两个来源不相加。

生产构建浏览器验收使用内存 SQLite、fake Runtime 和本机合成 HTTP 上游。无需手动导入，页面显示 3 次请求、总量 360、输入 300、输出 60；具体 `example-docs/search` 的定义输入为 60，首次结果和重复结果各为 2。执行次数为 0、上下文证据为 1，二者没有混算；输入证据可以下钻到对应模型请求。等待与不完整状态分别显示，不把未知视为零。

最终补充浏览器验收走通了仅定义 `unused_lookup`、Review Skill 和 Review Plugin 的模型输入列表与明细。未执行 MCP 的定义输入可定位到具体请求、位置与 21 token 单次估算；Skill／插件明细保留原 `skill-call` 关联和参数／结果位置，结果重复输入估算为 2，执行次数仍为 0。正常等待超过自动轮询预算后不再误报失败，可以手动刷新。临时页面和 loopback 预览服务已关闭。

历史规模回归保留 32,767 条旧上下文元数据和两条共享结果的真实暴露，最近日期查询仍得到首次 0／重复 2，不再出现 SQL 参数上限错误，也没有通过裁掉历史来改变归属。

沙箱内首次全量测试出现 loopback `listen EPERM`，进程测试也受进程表访问限制；在允许本机监听／进程检查的环境复跑。另有两处真实集成失败：服务就绪顺序和 SSE 测试的定时器所有权，已修复并通过上述新全量验证。

测试隔离曾有一次错误：Claude 替身命令未匹配版本后缀，误尝试原 `npx ...claude-agent-acp` 命令并在 5 秒后超时，未发送 ACP 业务输入或模型提示词。现有输出无法确认停在 npm 解析还是已启动程序；随后检查无对应残留进程。测试已增加替身路径强制校验和子进程超时，后续验证只调用受控替身。没有完成真实账户或账单验收。

范围外观察：SSE 测试排查时发现现有 `WebhookDispatcher.stop` 的 5 秒超时句柄在另一分支先完成后未清除，该行为早于本功能。没有混入本次 Agent Usage 修改；SSE 回归明确验证其自身及恢复采集器的定时器所有权。

## 原实现历史验证

## 范围

- 新账本持久保存来源观测，区分已报告用量、未知口径和模型输入估算；不把缓存子集、父范围汇总与请求明细重复相加。
- Agent／Session／日期／Runtime 查询共用投影；支持具体 MCP Tool、CLI、Skill、插件等维度及证据下钻。
- Codex／Claude Code 本地记录、Runtime 事件、MCP 执行观察器和显式上下文快照接入。快照合同为 `context-snapshot-v1`，来源为 `context_snapshot`。
- Reset／cleanup 先采集再删除来源，保留统计；显式 Session 删除撤销映射并清除其统计，拒收迟到数据。

## 验收证据

| 项目 | 验证方式与结果 |
| --- | --- |
| 会计口径 | 合成会计样例覆盖已知 3,300 token 与缺失请求、缓存子集、重放去重、修订、更正、父子范围重叠和超过 100 条记录 |
| 生命周期 | 聚焦用例覆盖失败、Reset、cleanup、delete、维护超时、重启恢复、删除与采集交错以及关闭等待 |
| 来源入口 | 经管理认证登记文件、显式绑定 Session／epoch、collect、查询状态和排名；包含非法路径、身份边界、来源重放与旧请求修订 |
| 快照示例 | `docs/examples/context-snapshot.json` 经实际解析器与 SQLite 投影验证：已报告 440 token，工具结果首次和重复输入各估算 2 token |
| 分析查询 | Agent／Session／Runtime 过滤、UTC 与 IANA 夏令时分桶、分页、同名不同 Server、未知值和 context/execution 证据口径 |
| 进程清理 | `rtk proxy corepack pnpm test:mcp-process`：3 个文件、56 个测试通过；使用本地合成 MCP／ACP 进程 |

最终修复后的全量测试、构建与浏览器结果如下；此前检查记录见[实施台账](../plans/2026-09-21-agent-usage-observability-progress.md)。

## 原实现测试结果（修复前）

- `rtk proxy corepack pnpm test --maxWorkers=4`：73 个文件通过、1 个跳过；936 个测试通过、17 个跳过，耗时 22.09 秒。
- `rtk proxy corepack pnpm typecheck`：服务端、Web 和 smoke 脚本类型检查通过。
- `rtk proxy corepack pnpm build`：生产编译通过，Vite 构建 2,082 个模块。
- 最终聚焦修复验证：4 个文件、35 个测试通过，覆盖 Claude 身份统一、采集状态刷新、仅执行／仅目录证据和部分估算标记。
- 最终审查发现的 3 项 P2 已修复，一次定向复审通过，没有遗留的必修问题。
- 浏览器使用生产构建、内存 SQLite、fake Runtime 和合成数据。已走通 Agent／Session／日期 → MCP Tool → 模型输入证据 → 首次 2／重复 2 token；同页重新采集后成功时间自动更新、按钮恢复可用；执行记录独有的 Session 显示 1 次调用和未知输入，不隐藏排名。Runtime 选项仅有一个 Claude 标识。
- `git diff --check` 通过；产品代码和测试中的命名为 Context Snapshot，研究项目名仅保留在出处说明中。

## 开销观测

Node.js 22.16.0、分词器已预热、内存 SQLite 中导入 1,000 个短文本上下文：导入约 100 ms，排名约 30 ms，进程 RSS 约 298 MiB。这是小型合成观测，不能推断真实大文件吞吐或最大负载。文件、上下文和分词量均有上限；采集每批让出事件循环。

进程测试最初在沙箱内因无法读取进程表失败（`ps: Operation not permitted`）；在允许本机监听和进程检查的环境重跑通过。该限制与代码测试失败分开记录。

## 交付边界

- 没有完成真实 Provider／外部集成 smoke 或账单验收，没有导入真实会话日志；替身命令的误调用事件已在上方单列。
- 本报告当时的工具 token 使用 `js-tiktoken@1.0.21`／`o200k_base` 参考编码估算；后续已替换为显式多模型词表，见[新的验证报告](2026-09-21-model-tokenizers.md)。需要模型输入来源；只有执行事件时显示调用事实和未知 token。
- 不依赖 Claude Code 原生遥测。自动采集默认关闭，支持显式配置的 Codex Responses／Claude Messages API-key 路由；Hermes 自动配置明确拒绝，OAuth／Bedrock／Vertex 不在此接入合同。上下文快照仍是本项目格式，没有集成 ContextSpy 或复制其源码。
- 子 Agent 范围仅支持明确映射主体的 `subagents=self`；不推断 Provider 内部子树，不计算无来源证据的工具内部 LLM 账单。
- 新账本不保留正文，没有诊断正文保留配置。旧 API 的 `usage`／`usageSummary` 保持原口径，新口径使用 `/api/usage/*`。
- 独立 CLI／独立应用分发属于后续提取阶段，当前实现位于本项目内。未提交、推送、部署或修改运行中服务。

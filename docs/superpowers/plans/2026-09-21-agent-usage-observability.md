# Agent 用量与能力归因：实施计划

状态：原始需求审查后的修复、独立复审与离线验收已完成。自动请求采集及审核缺陷按[修复计划](2026-09-21-agent-usage-review-fixes.md)落实；全量 994 测试通过、17 跳过，类型检查与生产构建通过。未提交、部署或完成真实 Provider／账单验收；测试隔离事件与支持边界见[验收报告](../validation/2026-09-21-agent-usage-observability.md)，过程见[实施台账](2026-09-21-agent-usage-observability-progress.md)。

设计依据：[实施设计](../specs/2026-09-21-agent-usage-observability-design.md)。用户已授权功能实现；早期 js-tiktoken 方案已由后续授权的[多模型词表方案](2026-09-21-model-tokenizers.md)替代，当前依赖 `@huggingface/tokenizers@0.2.0`。提交、推送、部署和真实 Provider 调用不在当前授权范围。

目标：先在现有项目完成 Agent / Session / 日期统计与具体能力归因闭环，再抽取独立分发。每个步骤同时交付正常数据和缺失数据的用户解释，不能把误导性报表留到最后处理。

## 1. 实施顺序与交付边界

```text
T0 口径与样例
  → T1 核心事件、存储与对账
  → T2 宿主生命周期和历史导入
  → T3 能力目录与 MCP / CLI 调用
  → T4 模型请求、内容与重复输入归因
  → T5 查询、界面和优化证据
  → T6 全链验证与交付
  → T7 后续独立分发
```

T1–T2 是账本里程碑，T3–T4 是归因里程碑，T5–T6 才构成首个功能版本。不要在只有调用次数、原始输出字符数时宣称完成“工具 token 消耗分析”。

不预先搭建插件加载框架、通用事件总线、多数据库支持、全套代理或分布式架构。首先用两个独立 Runtime 来源样例验证核心接口，再按实际需求抽象。

## 2. T0：固定口径和可复算样例

**改动候选：**新增 `test/fixtures/agent-usage/` 人工合成协议样例、适配器能力矩阵和必要的来源说明；不导入真实运行正文。

**工作：**

- 固定事件粒度、delta / cumulative / snapshot、输入缓存包含关系和每个来源的已知 / 待验证能力。
- 核对 acpx 用户消息 ID 与宿主 Run ID 的映射；不能直接把 perRequest 的 key 当 Run ID 或模型 request ID。
- 为 Codex 与 Claude Code 两个 Runtime 来源各准备至少一个多模型调用、多工具调用样例；样例证明解析合同，不冒充已完成真实 Provider 验收。
- 准备期望报表与详情文案，确认用户能从 Agent / 日期找到具体工具和缺失原因。
- 建立 `provenance.md`：拟借鉴的上游文件、固定版本、许可声明和修改范围；只有确实复制代码时才记录为 copied。

**基准样例：**三个已知模型请求的 inputTotal 分别为 1,000 / 1,400 / 600，outputTotal 为 100 / 150 / 50；第四个请求 usage 缺失。缓存读取总数 1,000 已包含在 inputTotal 中。

期望：已知模型 token 为 3,300，状态不完整；不能加缓存得到 4,300，也不能把第四个请求填零后宣称完整。一个 300-token 工具结果在后两次请求出现，结果首次输入为 300、重复输入为 300。这里的固定 token 数是会计测试输入；真实分词测试另外使用固定文本与编码器。

**验收：**每个数字都能手工复算；未知字段、时间不可定位和重复来源有明确期望；总量、上下文占用、工具原始产出三个概念分开。

## 3. T1：核心事件、持久化与对账

**改动候选：**`src/agent-usage/core/`、`storage/`、`source-coordinator.ts`、`src/db.ts` 的模块迁移接线；新增 `test/agent-usage-ledger.test.ts`、`test/agent-usage-storage.test.ts`、`test/agent-usage-sources.test.ts`。

**工作：**

- 实现版本化事件和最小 ingest 接口；通用字符串身份不导入宿主 Provider 枚举。
- 先建立 source、subject、source_mapping、event、invocation、ledger 表；事件 / 投影 / 游标共同提交，主体和映射 generation 在同一写事务内校验。
- 定义 SourceInput 判别合同与协调器 `registerSource / collect / prepareMaintenance / revokeSubject` 接口，用合成适配器验证有界采集、冻结来源位置和持久状态恢复；T2 可先用它验证生命周期，不等待 T4 的真实日志解析器。
- 实现来源去重、同范围修订、已验证累计差分、请求与范围汇总的非重叠选择。
- 保存未知、冲突、未定位区间、parser 版本和来源证据，不使用 max 或平均分配掩盖差异。
- 覆盖乱序 interim / final、显式更正和 Run 终结后补报；保留源字段数值与 epoch 事件以支持重放。
- 实现关闭 flush、故障状态与可重放游标；限制批大小和队列，不无限阻塞业务。保存活动采集任务状态，重启续读已接纳任务；同来源只允许一个活动采集。
- 实现主体 deleted / 映射 revoked 最小拒收标记；排队或在途 ingest / 分析即使已读完正文，也必须在提交时校验 generation，不能重建已删除数据或改存未归属。

**验收：**重复导入结果不变；两个相同内容的真实请求仍计两次；缓存子集不会重复求和；未知 scope / semantics 不进入可累加总量；重建投影与初次结果一致。

**完成边界：**这是存储和计量能力，尚不声称已接通所有 Agent。

## 4. T2：当前宿主、Reset 和历史数据

**改动候选：**`src/runtime/agent-runtime.ts`、`acpx-runtime.ts`、`provider-session-cleaner.ts`、`src/runs/run-executor.ts`、`run-repository.ts`、`src/sessions/session-manager.ts`、`session-maintenance.ts`、`src/app.ts`。

**工作：**

- 扩展内部观察接口，保留 usage 来源、范围与语义；既有业务 message / tool / status 事件顺序不受影响。
- Run 执行中保存 usage 观测；status 查询失败产生采集缺口，不伪造零值。
- 不对 acpx 最新 100 条求和当历史全量，也不直接差分名为 cumulative 的字段；仅对通过 T0 验证的来源 profile 开启对应累加。
- 保留 provider epoch。Reset 成功与 epoch 变更同事务；Reset 失败、idle eviction、重启有不同处理。
- 在第一次 discard / purge 前接入持久采集屏障：覆盖 runtime reset / forgetSession 的 `discardPersistentState: true`、Provider cleaner 和 Workspace 清理。必要时把停止生产者与丢弃状态分开；沿用维护 claim 阻止新 Run，冻结源代际 / 结束位置，提交 usage 及待删来源的归因派生数据后才允许删除源。
- 持久保存 maintenanceId、边界与 ready 状态；一次采集超时返回 `usage_collection_pending` 并保留来源与维护意图。恢复从原边界续做，采集已完成但 purge / epoch 提交前崩溃可幂等重试，不能无限挂起请求或提前创建新 epoch。
- 为旧 Session / Run 用量建立幂等导入和重叠对账；旧汇总标明不确定口径及不可分日期。
- 显式删除先在业务删除同一事务内撤销主体 / 来源映射、更新 generation，再删观测与投影；不等待保留统计屏障。取消相关任务，保留最小拒收标记，历史导入、迟到 final、投影重建和来源重放统一拒收已删范围。
- 首版不保存正文；清理归因元数据时检查共享引用。共享来源不整体停用，其他 Session 仍可采集。cleanup 保存统计，删除清除统计，两者不可混用。
- 定义旧 usageSummary / Session usage 的映射，先对照再切换；不能悄悄改变现有 API 的字段含义。

**验收：**扩展 `test/runtime.test.ts`、`test/run-executor.test.ts`、`test/runs.test.ts`、`test/session-maintenance.test.ts`、`test/session-cleanup.test.ts`。覆盖超过 100 分组、运行中失败、取消、超时、最终状态查询失败、重启、Reset、清理与删除。

**新增生命周期回归：**Run 已结束但日志尾部未读就 Reset / cleanup；屏障超时或数据库故障时源文件仍存在；屏障 ready 后崩溃再恢复仅切一次 epoch；删除与采集 / 分析提交并发、迟到 final、重启重放及历史导入不复活数据；同一来源其他 Session 和共享内容不被误删。

**交付体验：**Agent / Session 可显示已知总量和数据质量。只有范围汇总时，精确日期趋势和工具费用仍明确不可用。

## 5. T3：能力目录与 MCP / CLI 实际调用

**改动候选：**新增 capability registry 与 collector；接入 `src/mcp/run-mcp-preparer.ts`、`mcp-tool-filter.ts`、`mcp-tool-filter-process.ts`、`src/runtime/skill-projector.ts`、Provider extension 元数据。

**工作：**

- 登记稳定 Server / Tool / Skill / 插件身份、版本和 Runtime 别名映射，不以名称相同为同一能力。
- 工具定义发现与实际模型暴露分开；Skill 投影与实际读取分开。
- 为无 allowedTools 限制的 MCP 提供透明观察路径，复用已安装的 MCP SDK。
- 独立本地通道收集调用事件，保持 stdout 协议纯净；宿主统一写库。
- 在工具开始时冻结关联，支持同一 MCP 进程被多个串行 Run 复用；无明确执行身份的关联标推断或未知。
- 区分 MCP transport error、`isError` 工具结果、取消、未完成；进度通知只更新状态。
- CLI 只在可靠事件提供 executable / 进程边界时细分；组合脚本不按字符串猜出所有内部工具。

**验收：**扩展 `test/mcp-tool-filter.test.ts`、`test/mcp-runtime.test.ts`、`test/skill-projection.test.ts`，新增 capability / invocation 测试。两个 Server 的同名 Tool 分开；Runtime + wrapper 重复观察不双计；迟到完成不归下一 Run；Skill 仅投影时使用次数不增加。

**进程验证：**包装或通道改变进程生命周期时运行本地 MCP / acpx 清理套件，确认成功、失败、超时、取消、重启关闭路径不留子进程。

## 6. T4：模型请求、内容和重复输入

**改动候选：**`src/agent-usage/adapters/` 来源解析；`core/` 的 context normalizer / attribution；内容块与 exposure 表；`src/agent-usage/source-routes.ts`、`src/app.ts` 接线与部署配置中的显式导入根目录。

**工作：**

- 用量来源先实现 Codex 本地记录，再实现 Claude Code 本地记录。上下文层实现 canonical invocation 导入／观察接口，配套通用上下文快照（Context Snapshot）手动入口及显式 opt-in 的 HTTP/SSE 自动请求采集，不启动强制代理。支持范围必须由真实 Runtime 配置到受控请求的测试证明。
- 上下文快照采用本项目的 `context-snapshot-v1` 合同及 `context_snapshot` 来源标识，不宣称集成第三方代理或支持其原生导出。只消费请求正文、Provider usage 和完整度等源证据，不采用外部工具汇总；来源 Session 到宿主 Session / epoch 必须显式关联，递增 revision 的旧请求修订不得因时间游标漏掉。
- 实现首版管理入口 `POST /api/usage/sources`、`POST /api/usage/sources/:id/collect` 与 `GET /api/usage/sources`，请求 / 状态合同采用设计第 6.4 节；来源登记通过 sourceKey 幂等，collect 同来源复用活动任务并返回 202。
- 宿主校验来源路径、Session / epoch / Run 映射与删除标记；输入限已管理的 Provider Session 相对路径或显式 importRootId 下的文件，拒绝任意绝对路径、远端 URL 和越界符号链接。注册映射与 collect 不能绕过主体撤销检查。
- app.ts 注册 T1 协调器、适配器和路由，启动恢复活动采集，Run 收尾触发宿主管理日志采集，关闭有界停止并提交批次。写入可执行管理 API 操作文档，首版不要求独立 CLI 或新增完整配置界面。
- 快照适配消费已经归一化的请求／响应；HTTP/SSE 转发适配负责在线采集与流式归并，两者共用规范化入口。明确前驱缺失时标为 partial。当前 HTTP 合同不包含 WebSocket；Codex 受控入口显式使用 HTTP/SSE。开源归一化思路的出处保留在设计参考章节。
- 调用参数生成与历史重放分开；响应回显的配置不算生成输出；流式分片不当独立请求。
- 对实际可见定义、调用参数、结果、Skill 内容建立 exposure；截断 / 摘要 / opaque 保留不同状态。
- 分词复用选定开源实现，记录版本；未选定或不支持的模态返回未知，不以字符比例冒充精确 token。
- 未识别 Tool 保留 unknown；没有 definition 的 result 仍可独立计量。
- 插件和 Skill 使用 exposure 去重汇总；明确哪些是来源证据、哪些是推断关系。
- 首版仅保存元数据、计数和关联，不提供诊断正文保留。后续如增加该配置，需另行实现加密、容量与期限控制。

**依赖决策：**实现前明确最小 tokenizer / instrumentation 依赖；新的生产依赖按仓库规则获得单独授权。代理和外部 OTel 后端均不成为所有用户的启动前提。

**验收：**新增 `test/agent-usage-context.test.ts`、`test/agent-usage-attribution.test.ts` 与两个来源的 parser 测试；覆盖重复输入、单请求重复 occurrence、截断、压缩、继承历史、多工具相同内容、正文清理以及 Provider 与分词差异。

**入口集成验收：**新增 `test/agent-usage-source-api.test.ts`，经真实管理认证注册合成上下文快照并绑定 Session / epoch → collect → 查来源状态 → 查询具体 MCP Tool 排名。验证认证 / 路径 / 所属关系、注册重试、重复 collect、重启断点续采、同请求 final 修订、已删除范围拒收；不得只调用内部 ingest 冒充入口已可用。T4 提供可查询的核心投影，T5 完成排名 HTTP 路由后运行完整下钻链。

**交付体验：**同一个 MCP Tool 排名可点到某次调用，再点到后续模型请求中的可见结果。仅有执行观察器的来源仍展示调用排名，但不可用的 token 排名有原因。

## 7. T5：查询、界面和有依据的建议

**改动候选：**`src/agent-usage/query/`、管理路由、`src/app.ts`、`src/web/api.ts`、Agent / Session 页面与新的用量分析页。

**工作：**

- 提供设计中的 summary、timeseries、capabilities、invocations 查询；复用 T4 已接入的 sources 管理入口，不重复创建来源存储。
- 实现 Agent / Session / 日期 / Runtime 筛选；首版子 Agent 范围固定为 `subagents=self`，只统计已明确映射的主体。UTC 存储，IANA 时区日界线，未定位历史单列。
- 排名切换调用数、定义输入、结果首次 / 重复输入、总输入贡献、失败与耗时；默认按累计输入贡献排序并展示覆盖范围。
- 内部查询结果复用到全局、Agent、Session 入口，不各写一套 SQL 口径。
- 明确会话全部 / 当前日期范围的区别；含后代视图等待可靠的原生子执行身份来源，不推断父子关系。
- 实现缺失、空、错误、分析中、正文已清理等状态；所有文案走既有中英文机制。
- 首版提供确定性优化提示：反复输入、无调用定义暴露和失败调用；每条都可打开证据。失败调用不等同于已证明重试。

**验收：**新增 `test/agent-usage-api.test.ts`、`test/web-agent-usage.test.tsx`；使用真实管理认证与路由验证 schema / 权限 / 序列化。覆盖时区、分页、返回筛选、同名工具、unknown 显示和未经授权不能读取正文。

**用户验收走查：**使用 T0 样例从 Agent → 日期 → MCP Tool → 具体调用 → 请求内容 → 重复输入证据，确认每一步无需知道内部表名或协议细节。

## 8. T6：验证、文档和交付

按改动范围先跑聚焦 Vitest，再执行完整自动测试、typecheck、build、diff 检查。使用仓库固定 pnpm，通过 `rtk proxy corepack pnpm ...` 调用。

本地进程套件仅在相关改动时执行；真实 Provider / 外部系统 smoke 需要另行授权，离线通过不替代它。

实际实现改变产品行为时，更新 `README.md`、`README.en.md`、`docs/design.md`、`docs/design.en.md`；采集开关、路径、容量、保留期限、升级与备份操作写入 `docs/deployment.md`，操作入口与可执行样例写入 `docs/agent-usage.md`。

交付检查：

- [x] 总量与 T0 期望一致，缺失明确，重放幂等。
- [x] 失败 / Reset / cleanup / delete 分别符合合同。
- [x] 删除源前完成采集与必要归因；超时保留源，重启幂等恢复；已删主体不能被迟到事件或导入重建。
- [x] 可通过首版管理 API 完成登记、显式映射、collect、状态查询和 Tool 排名，无需等待独立 CLI。
- [x] 两种 Runtime 来源样例通过同一核心，不隐瞒粒度差异。
- [x] 具体 MCP Tool 有身份、调用排名、内容归因与下钻。
- [x] Skill / 插件 / CLI 视角可解释且不会重叠相加。
- [x] Agent / Session / 日期筛选、时区口径一致；子 Agent 首版仅 `self`，不伪造后代覆盖。
- [x] 真实运行正文与凭据不进入公开事件、测试夹具或代码仓库；样例全部为合成数据。
- [x] 数据缺口、未知值、正文未保留和采集状态均有实际界面状态。
- [x] 记录小型合成开销观测、输入与采集上限和失效行为，不宣称生产负载验收。
- [x] 执行完整合成用户走查；离线验证通过，真实 Provider 验证未运行。

## 9. T7：后续独立分发

在 T6 验收后提取核心、SQLite 存储与来源适配器，不提前拆仓：

- 嵌入模式：宿主调用 ingest / query，自行提供身份、认证和数据目录。
- CLI 模式：显式选择日志来源并导入，输出 JSON / 终端报告；支持断点续导。
- 独立应用：本地 collector + SQLite + 复用界面，自有 Session / Agent 映射。
- 可选集成：OTLP 导出到已有观测平台；账本不依赖被采样的 trace 作为唯一来源。

首次提取的验收条件是一个不依赖 remote-agent-server Manager、数据库业务表或 Provider 枚举的小宿主样例能够完成相同导入和查询。暂不要求跨平台进程管理、多人 SaaS 或分布式部署。

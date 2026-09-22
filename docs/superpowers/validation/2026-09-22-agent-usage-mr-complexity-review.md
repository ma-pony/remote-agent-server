# Agent 用量 MR 全面复杂度审查

日期：2026-09-22。范围为主分支 `9094485` 到 `codex/agent-usage-observability` 的完整功能差异，以及本轮修复后的工作树；不是仅审查本轮新增代码。未提交或推送本轮修改，原有 README 产品介绍改动保留。

## 结论

功能的主要复杂度来自不同来源的计量语义、历史回放、首次暴露、持久恢复及资源清理。它们有对应合同和回归测试，不能用合并表、删除状态或共享全局缓存来替代。可以降低的是重复计算、逐条查询、重复维护准备，以及前端多份状态的同步。

本轮保留现有单进程 SQLite 架构、采集适配器边界和来源协议；没有新增生产依赖、后台服务、通用查询框架或独立发布包。

## 全范围审查记录

| 范围 | 检查内容与处理 |
| --- | --- |
| `core/types.ts`、`core/usage.ts`、`storage/usage-store.ts` | 核对 reported/derived/estimated、未知字段、缓存子集、revision 和父子范围选择。汇总与趋势交由同一查询内分析对象处理；按 Session/epoch/execution 建索引，避免逐个父范围遍历全量历史。 |
| `core/context.ts`、`core/context-types.ts` | 核对能力身份、暴露、实际执行与输入证据的区别。删除没有调用方的旧内存首次暴露算法；持久索引成为实际使用的唯一实现。 |
| `core/tokenizers.ts`、`tokenizer-config.ts` | 保留本地资产验证、精确模型映射、未知模型兜底、词表指纹及有界纯计数缓存；不把分词和 Provider 上报混为同一账目。 |
| `storage/attribution-store.ts`、`storage/result-first-use.ts` | 检查写入、修订、日期范围、跨来源执行提升、分页、首次/重复分类及删除。保留字典去重、首次结果索引、证据排序键和已有数据迁移；这些机制避免历史重扫或误归因，不能单纯按代码长度删减。 |
| `adapters/file-source.ts`、`adapters/provider-logs.ts` | 检查文件身份、旧前缀验证、尾部增量解析、半行、checkpoint、累计增量和取消。保留冻结/校验/解析三者的不同职责。 |
| `adapters/context-snapshot.ts` | HTTP 与手动导入继续共用归一化。历史调用保留首次确认的 Skill/plugin 归属；复用未变化调用对象，避免历史回放时重复序列化和写入。模型选择表达式只保留一份。 |
| `source-coordinator.ts`、`managed-sources.ts` | 统一来源筛选，非空结果使用两次查询批量取得来源和完整映射；宿主、API、发现和注册复用该入口。删除未使用的第二个恢复执行入口，保留宿主拥有的恢复队列。 |
| `host-collector.ts` | 后台恢复在 SQL 中筛除已完成会话；单会话维护只导入该会话及其 Run。已 ready 的维护屏障直接复用，避免再次读取可能已部分清理的文件。删除会话时释放 producer 集合项。 |
| `capture/config.ts`、`capture/runtime-config.ts` | 检查上游协议限制、凭据所有权和子进程临时配置，保留明确配置及不支持的 Provider 拒绝分支。 |
| `capture/http-relay.ts`、`capture/protocol.ts`、`capture/host-capture.ts` | 检查转发、解压、SSE、超限、中断、事务回滚和路由释放。展开压缩的控制流，移除未初始化 route 的强制类型断言，使用局部解码错误类型。MCP 别名按 Map/冲突集合线性去重。 |
| `mcp-observer.ts`、`mcp-observer-client.ts`、`src/mcp/` 接入改动 | 检查 ticket、开始/结束确认、包装透明性、实际调用计数和进程退出。保留本地 socket 与 HTTP 请求观察的独立职责；前者证明执行，后者证明模型输入。 |
| `runtime-capabilities.ts`、`src/runtime/` 接入改动 | 内置工具与结构化 CLI 的能力身份统一；不解析复合 Shell 字符串猜测内部命令。核对 Skill 投影、MCP 镜像排除、Run 绑定和 Runtime 释放；补齐 Provider 恢复出不同会话 ID 时的采集路由撤销。 |
| `src/runs/`、`src/sessions/` 接入改动 | 检查成功、失败、取消、Reset、cleanup、删除、恢复及关闭。保留持久维护占用与 generation/epoch 拒收机制，避免简化后丢统计或重新导入已删会话。 |
| `query-routes.ts`、`source-routes.ts` | 汇总/趋势业务逻辑移出路由；来源筛选不再逐映射查库。使用 `UsageError.code` 映射业务错误，内部故障返回脱敏 500。来源列表新增同一映射上的 Agent/Session 筛选。 |
| `src/web/` 全部接入改动 | 检查入口、筛选、独立刷新、采集轮询、空/错/加载态、证据类型和分页。来源列表使用服务端筛选；抽屉按主体/能力身份重建，游标由历史栈派生；详情请求可取消且忽略过期响应；无效 URL 时区回退。 |
| `app.ts`、`main.ts`、`config.ts` | 核对初始化、认证、配置校验、启动恢复和关闭顺序。没有把采集正文加入公共集成事件，也没有引入第二个服务进程。 |
| 依赖、配置、测试、README 与设计/部署文档 | 检查新依赖与配置用途、合成 fixture 标识及验收边界。同步中英文来源筛选/证据行为和维护语义；历史验收文档保留其原时间范围。 |

## 可验证的优化

- 非空来源列表固定两次 SQL 查询；新增 101 个来源、跨 namespace、共享来源、多映射、撤销及 Agent/Session 组合的回归测试。
- 已完成的维护屏障不再次发现日志；用第二次发现直接抛错的测试证明重试不会依赖已清理文件。
- 证据切换时旧详情响应覆盖当前内容的问题先由 UI 测试复现，再验证修复；另覆盖关闭重开、分页前进/后退和切换证据类型后游标重置。
- Provider 会话 ID 不匹配时，两个本地 HTTP 回归用例复现了失败后采集路由仍可转发的问题；补齐清理后路由返回 404，覆盖 Handle 正常关闭和关闭失败两种情况。
- 新旧汇总算法对照：固定种子 `12345678`，100 组混合来源/范围/指标数据，每组 5 个筛选，共 500 次比较；除查询时间外结果一致。
- 同机一次性合成基准：6,000 个 Session、12,000 条账本记录，每个 Session 一条累计父范围和一条有时间区间的明细，查询无命中日期。修复前 summary 约 2,222 ms、timeseries 约 2,497 ms；最终实现约 145 ms、95 ms。使用 Fastify 注入请求，包含路由查询与序列化，不包含外网或真实 Provider。该数字不是性能承诺。

## 验证与边界

最终工作树验证：

- `pnpm test`：1046 通过、17 按配置跳过，78 个测试文件通过、1 个跳过。
- `pnpm test:mcp-process`：56 通过，覆盖本地真实 MCP/acpx 进程清理；与完整测试有重叠，不叠加为唯一测试总数。
- `pnpm typecheck`：通过，包含服务端、前端和 smoke 脚本类型检查。
- `pnpm build`：通过，服务端编译及前端生产构建完成。
- `git diff --check`：通过。

前端交互使用现有组件，核对了 [shadcn Tabs](https://ui.shadcn.com/docs/components/radix/tabs) 与 [Sheet](https://ui.shadcn.com/docs/components/radix/sheet) 的官方用法；没有升级或重装组件。

模型汇总仍需读取所选主体的历史元数据以核对父范围与未归位总量；排名仍需处理所选范围的暴露与调用样本。内存和 CPU 成本随相应历史增长，本轮未宣称任意规模下成本固定。原始模型正文不进入新统计表；文件前缀验证仍有有界读盘成本。

本轮没有执行真实 Provider 或外部业务烟测、部署或服务重启。自动采集的协议、管理 API、前端交互和 MCP/acpx 进程树已在受控本地测试中验证；它们不能代替真实上游和生产容量验收。Hermes 自动 HTTP 采集、未暴露的 Hook/内部子 Agent 调用仍沿用现有明确边界，不通过推断补造数据。

# Capability 排名聚合优化验证

日期：2026-10-12。使用 Node.js 22.16.0 和本地合成 SQLite，未访问生产数据或真实 Provider。

## 对比边界

本轮基线是 `1ba56d6` 的 `AttributionStore` 加上此前完成的 context-call `CROSS JOIN` 修复，修改聚合前已冻结为独立模块。两版读取相同数据库，比较完整 `rankingsPage` 返回值，包括数组顺序；不忽略任何字段。本轮性能数字不包含此前修正关联子查询顺序的收益。

改动把数值、估算配置和紧凑投影中的首次使用统计合入一次输入扫描。先按 capability / estimate 聚合，再连接估算配置表。覆盖率通过现有主键覆盖索引独立去重，避免在宽行数值聚合中维护四套 `COUNT(DISTINCT)`。明细回退仍使用原有的首次使用索引；调用去重、精确 P50/P95、时间边界、最新展示信息和空值口径保持不变。

没有新增表、索引、保留条件、清理门禁或超时预算，也没有改变 API 契约。

## 完整响应差分

`scripts/verify-usage-ranking-versions.ts` 使用公开写入方法建立 context / invocation 数据，并加入新旧格式的对话内容估算配置。比较 13 种筛选 × 4 种维度 × 12 种排序 × 3 种分页 × 3 个状态，共 **5,616 组**，结果全部相等。

三个状态是紧凑投影、强制明细回退、重新回填后再处理迟到上下文／修订／Session 删除。筛选包含 namespace、Agent、Session、Runtime、上下界、非 UTC 零点边界、缺失时间与空范围；分页包含完整页、部分页和越界空页。数据覆盖未知与零 token、多估算配置、四类覆盖率、首次／重复／未知首次、跨窗口 context-only 调用和不同执行状态。

新增单元回归特别验证：同一 context 的多个估算配置只贡献一次覆盖率；存在但不可计数的 definition / arguments / first-result 仍为 `null`；不存在的类别为 `0`；已知零值不会被转成未知。

## 性能

`scripts/benchmark-usage-ranking-versions.ts` 生成 4,000 个 context、720,000 条紧凑输入、80,000 次调用、80,000 条对话分片。两版各用一个只读连接，SQLite WAL、页缓存 8 MiB；各自预热一次后交替执行五轮。每次均比较完整响应。下表为五轮耗时中位数，不是生产 p95。

| 查询 | 优化前 | 优化后 | 耗时减少 |
| --- | ---: | ---: | ---: |
| 七天输入排名 | 7,249.67 ms | 5,336.01 ms | 26.4% |
| 一天输入排名 | 1,300.26 ms | 992.14 ms | 23.7% |
| 七天观测内容排名 | 7,942.58 ms | 4,013.58 ms | 49.5% |

完整样本（ms，按各版本执行顺序）：

| 查询 | 优化前五次 | 优化后五次 |
| --- | --- | --- |
| 七天输入 | 6382.35, 7249.67, 6500.01, 12471.42, 8527.57 | 4234.88, 5336.01, 5781.77, 8490.33, 4416.83 |
| 一天输入 | 926.76, 1272.64, 1300.26, 4169.24, 1804.29 | 560.33, 685.70, 1016.17, 992.14, 1290.47 |
| 七天观测内容 | 7360.02, 7942.58, 9239.22, 6948.01, 9765.86 | 4013.58, 3857.32, 3983.29, 5125.27, 6826.08 |

存在明显耗时波动，不能据此推导生产千万行数据的绝对延迟。性能脚本直接构造既有紧凑投影以测量读取成本；投影生成及失效正确性由公开写入差分和回归测试验证。所有基准数据库在 `finally` 中删除。

## 复现

从仓库根目录生成本轮聚合优化前的模块（依赖仍解析到当前源树，因为本次仅修改查询）：

```sh
rtk proxy python3 - <<'PY'
from pathlib import Path
import subprocess
import tempfile
root = Path.cwd()
source = subprocess.check_output([
    'rtk', 'proxy', 'git', 'show',
    '1ba56d6:src/agent-usage/storage/attribution-store.ts'
], text=True)
source = source.replace(
    'e JOIN agent_usage_contexts c ON c.context_id=e.context_id',
    'e CROSS JOIN agent_usage_contexts c ON c.context_id=e.context_id'
)
source = source.replace('from "../', 'from "' + str(root / 'src/agent-usage') + '/')
source = source.replace('from "./', 'from "' + str(root / 'src/agent-usage/storage') + '/')
path = Path(tempfile.mkdtemp(prefix='usage-ranking-baseline-')) / 'attribution-store.ts'
path.write_text(source)
print(path)
PY
```

将打印的模块路径传给两个脚本：

```sh
rtk proxy corepack pnpm exec tsx scripts/verify-usage-ranking-versions.ts <baseline-module>
rtk proxy corepack pnpm exec tsx scripts/benchmark-usage-ranking-versions.ts <baseline-module> 4000
```

基准默认 1,000 个 context，可传入 1–5,000；性能比较应独立运行，避免并行测试或构建争用资源。二者只使用本地合成数据，不需要凭据。

## 当前工作树检查

- `pnpm exec vitest run agent-usage --maxWorkers=2`：37 个文件、478 个用例全部通过。
- `pnpm typecheck`：通过；两个新增验证脚本另行以严格模式、NodeNext、ES2024、`skipLibCheck` 做类型检查，通过。
- `pnpm build`：通过。
- 按上面的 Git 基线重建命令重新执行差分脚本：5,616 组全部相等。
- `git diff --check`：通过。

未运行无关模块的完整测试集或真实 Provider／外部集成烟测。未提交、推送或部署；目标环境的冷读、并发排队和生产 p95 尚未验证。

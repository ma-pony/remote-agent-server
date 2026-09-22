# 用量分析与自动请求采集

“用量分析”按 Agent、Session 和日期查询已知模型用量，并按具体 MCP Tool、内置工具、CLI、Skill、插件查看调用与输入贡献。模型账单用量来自来源报告；工具内容使用 `@huggingface/tokenizers@0.2.0`，按实际模型匹配显式配置的本地词表估算。未配置词表时使用通用文本兜底估算，保留调用和输入字节数，排名仍有可用数值。两者分别显示，不能把工具估算加到模型总量上，也不能跨 Skill／插件等重叠视角相加。

## 采集范围

| 来源 | 自动采集 | 能说明什么 |
| --- | --- | --- |
| Runtime 事件 | 是 | Run 用量证据、结构化工具调用；语义未经确认的计数不进入可累加总量 |
| Codex 本地记录 | 启动恢复、Run 收尾、维护前及关闭后 | 已报告的 Provider Session 累计范围，以及有连续基线的同日增量；没有请求身份时不虚构请求数 |
| Claude Code 本地记录 | 启动恢复、Run 收尾、维护前及关闭后 | assistant usage 和稳定消息身份；不启用 Claude Code 原生遥测 |
| MCP 观察器 | 服务管理的 MCP 包装进程 | Server／Tool 身份、执行次数、结果字节数、状态、耗时；不代表最终模型输入 |
| Runtime Skill／CLI 证据 | 是，取决于事件字段 | Skill 目录可见、正文读取、参考文件读取、脚本执行；CLI 只细分可靠的外层 executable |
| 模型 HTTP 请求采集 | 配置上游后，对支持的托管 Runtime 自动接入 | 真实发送的模型输入、SSE／JSON 上报用量、具体工具定义和结果的输入贡献 |
| 上下文快照 | 显式登记后手动采集 | 已归一化模型请求／响应中的定义、参数、工具结果及重复输入 |

没有可靠上下文来源时，工具 token 显示“未采集模型输入”。组合 Shell 命令不会按字符串拆成若干 CLI；结构化 MCP 镜像不会再计入 CLI。仅投影的 Skill 不是已使用；插件仅在投影或快照提供明确归属时可分析。不认识的日志、工具身份和 Provider 内部调用保留未知，未知不是零。

旧 Session 和 Run 计数会幂等保留为未验证证据，不与新来源重复累加。旧业务 API 的 `usage`／`usageSummary` 字段保持原语义；需要新账本口径时使用 `/api/usage/*`。

## 如何读报表

- `usage` 是当前筛选范围内可计量的已知部分；同时看 `completeness`、缺失请求数与来源状态。它不证明未观察到的调用为零。
- 缓存读取／写入属于输入子集，不重复相加。Codex 连续累计记录的可信差额可形成时间区间；初始基线、跨 UTC 日或倒退计数不能直接分摊。日期筛选要求完整区间落入范围，按所选时区分桶时也不能跨桶。未定位部分单列，不使用导入日期。
- `calls` 只计实际执行，按工具开始时间筛选；`contextOnlyCalls` 单列主要工具的上下文调用记录，按关联模型请求时间筛选。后者不证明工具在本次采集期间执行，也不加入实际调用数；它不等于所有能力的输入证据条数。Skill／插件标签、仅定义等暴露通过模型请求输入证据查看，不为其虚构调用记录。执行记录缺少开始时间时仅在不限日期的执行列表中出现。
- 首次／重复根据 Session 和 Provider epoch 的完整已知历史分类；选择另一日期不会把重复输入重新算作首次。采集前历史不完整时，首次状态保留未知。
- 不同 Server 的同名 Tool 分开。模型输入证据与包装进程的执行 ID 无法关联时分别展示，不能只凭内容或时间认定为同一次调用。
- 分词结果是按配置模型词表进行的文本估算，图片等不支持的内容、过大块和不完整上下文保留缺口。查看调用详情可以检查出现位置与计数；新账本不保留正文。

## 配置多模型词表

`USAGE_TOKENIZERS` 默认为 `[]`。分词引擎支持不同模型配置，但不会内置所有模型词表。未匹配模型或缺少模型名时自动使用 `unicode-weighted-v1` 兜底，不需要额外配置，也不冒用某个模型词表。响应返回模型名时优先使用该名称；否则使用快照记录或请求中的模型名。`models` 必须列出实际会出现的完整名称，不使用通配符。

把可信来源的 `tokenizer.json` 和 `tokenizer_config.json` 放在服务可读目录，固定下载版本并验证 SHA-256。例如下面的 Qwen 配置对应公开仓库 `Qwen/Qwen2.5-0.5B` 的 revision `060db6499f32faf8b98477b0a26969ef7d8b9987`：

```dotenv
USAGE_TOKENIZERS='[{"id":"qwen25-05b","models":["Qwen/Qwen2.5-0.5B"],"tokenizerPath":"/srv/remote-agent/tokenizers/qwen25-05b/tokenizer.json","configPath":"/srv/remote-agent/tokenizers/qwen25-05b/tokenizer_config.json","tokenizerSha256":"c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539","configSha256":"c91efca15ceff6e9ee9424db58a6f59cd41294e550a86cbd07e3c1fb500b34f9"}]'
```

词表来源：[tokenizer.json](https://huggingface.co/Qwen/Qwen2.5-0.5B/resolve/060db6499f32faf8b98477b0a26969ef7d8b9987/tokenizer.json)、[tokenizer_config.json](https://huggingface.co/Qwen/Qwen2.5-0.5B/resolve/060db6499f32faf8b98477b0a26969ef7d8b9987/tokenizer_config.json)。配置中的路径由操作者创建；服务不会下载文件或加载模型权重。更换模型时需要使用其自身词表、配置和哈希，不能只改 `models`。

可以为 profile 设置 `modelProvider`，用于区分不同上游的同名模型。HTTP 采集的上游配置也设置同值；手动快照在对应 `requests[]` 记录上提供同名字段。来源没有该身份时不会命中限定 Provider 的 profile。不限定 Provider 的 profile 是操作者对这些完整模型名的显式通用绑定；更具体的 Provider 绑定优先。

配置在下一次启动加载，最多 16 个 profile、每个 100 个模型名；单词表最多 16 MiB，配置文件最多 1 MiB，总文件量最多 64 MiB。只接受本地普通文件和正确哈希，缺失、损坏或重复匹配使启动失败。采集期间不再读取词表文件。单文本块 256 KiB、每上下文 1 MiB 的估算上限继续生效。

估算只数可见文本，不为每块添加 BOS/EOS 等模板标记；正文中的特殊标记按普通文本处理，因此即便词表匹配，也不是完整请求或账单的精确重建。BPE 正文缓存关闭，有限的计数缓存只保存哈希和数字。

排名与明细保留模型、Provider、引擎版本、profile ID、词表内容指纹及缺口原因。旧数据保留为 `legacy_reference`，不会因更换配置重新标为新模型计数。多个模型、词表版本及兜底估算分别展示，也汇成近似 token 小计供排名，并标明“混合估算”。可以按 token、输入字节或实际调用次数排序。估算完整表示各项都有数值，不表示等同于准确账单。

兜底按 Unicode 码点线性扫描：ASCII 字母、数字和空白权重为 0.25，ASCII 符号为 0.5，其他 BMP 码点为 1，补充平面码点为 2；总和向上取整，空文本为 0。它按字符类型粗估，中英文、代码符号和 Emoji 不统一除以四。界面显示“兜底估算（按字符类型加权）”，持久化 `method=text_heuristic`、`heuristicVersion=unicode-weighted-v1` 及触发原因，配置模型词表后优先使用词表。此规则用于定位大输入与重复输入，未声明误差范围；不会为图片、缺失正文或超过处理上限的内容猜一个数。历史无正文缺口也不凭字节数重新伪造 token。

Claude 等未配置兼容本地词表的模型继续显示已报告 usage，工具级 token 使用兜底估算并说明原因。官方远程 token-count API 尚未接入；当前不会把正文再次发往外部计数服务。不能使用旧 Claude 或其他模型词表冒充当前模型的准确计数。

## 启用自动请求采集

自动采集通过服务拥有的 loopback HTTP 转发入口观察真实模型请求，无需自行生成上下文快照，也不依赖 Claude 原生遥测。默认关闭；由运维显式指定允许使用的上游与 API key 环境变量名。例如：

```dotenv
USAGE_CAPTURE_UPSTREAMS='{"codex":{"baseUrl":"https://api.openai.com/v1","protocol":"responses","apiKeyEnv":"USAGE_OPENAI_API_KEY"},"claude_code":{"baseUrl":"https://api.anthropic.com","protocol":"anthropic_messages","apiKeyEnv":"USAGE_ANTHROPIC_API_KEY"}}'
```

相应 `USAGE_OPENAI_API_KEY`／`USAGE_ANTHROPIC_API_KEY` 由服务的 Secret 管理方式注入，不放入上述 JSON、仓库或导入快照。上游地址必须使用 HTTPS，本机测试可用 loopback HTTP；拒绝 URL 内嵌凭据、query 和 fragment。配置在服务下次启动生效，不会修改全局 Provider 配置。

此模式显式选择 API-key 路由。托管 Provider 只收到临时本地凭据和入口，转发层移除传入认证信息后注入所配置的上游 key。Codex 使用 Responses HTTP/SSE，关闭该托管入口的 WebSocket；Claude 使用 Messages HTTP/SSE。现成 OAuth、Bedrock、Vertex 以及绕过此入口的内部模型调用不属于该采集合同，不能因为启用了配置就声称全部覆盖。Chat Completions 的通用协议适配器也用于兼容端点。

当前自动 Runtime 接入仅支持 `codex` 和 `claude_code`；配置 `hermes` 会明确报错。通用 Chat Completions 协议支持不等于已经接通 Hermes 的实际启动配置。未启用自动采集的 Runtime 继续使用已有日志与执行事件来源。

运行后查看用量页的采集状态，再检查具体 MCP Tool 排名。只有实际收到请求才有采集证据；“等待请求”、中断、解析失败或超限不会显示成已完整采集。请求正文只在内存中短暂处理，数据库保存用量、哈希、字节数、身份和估算结果，不保存请求／响应或工具正文。

管理汇总中的 `captureHealth` 按会话／epoch 返回运行时、状态、已观察请求数、不完整次数和稳定错误码。状态为 `waiting`、`pending`、`observed`、`incomplete`；`observed` 表示收到了请求，不保证所有远端历史或内部调用都已覆盖。服务重启会把未收尾的采集标为中断。

HTTP 观察副本的请求／响应各限 2 MiB，解压后各限 4 MiB，单 SSE 事件限 1 MiB，同时观察处理最多 64 个请求。超限后仍继续转发，并记录采集缺口。支持 gzip、deflate、brotli；zstd 取决于所运行 Node 22 小版本是否提供对应解码能力，不支持时明确保留缺口。每 Session／epoch 最多保留 2,048 个无正文工具调用身份，用于关联后续结果。

自动归因使用托管 MCP 身份与逐调用证据：同名但不同 Server 的工具分开；只有某次读取明确命中已投影 Skill 路径时，才给该次参数／结果增加 Skill 与已知插件归属。不会把所有 Read、整个后续推理或所有工具定义归给该 Skill。未知身份继续显示 unknown。

已识别的内置工具和结构化 CLI 复用 Runtime 能力身份，因此调用次数与模型输入估算可在同一能力排名中查看。只有显式 executable／program／argv 才细分 CLI；Shell 定义及组合命令归到 Shell，不给每个内部程序分摊定义。Provider 未知工具名仍为 unknown，MCP 的显式映射优先。无正文调用缓存保留首次确认的 Skill／插件标签（包括空标签），历史调用在后续 Run 重放时不会按新配置改写归属。

传输捕获完整也不代表服务端隐式历史完整。`previous_response_id`、远端 conversation、未知模态、加密内容及采集中断保留 partial／opaque；模型账单用量仍独立使用响应上报字段。原生日志和请求采集按共同身份对账，不能直接相加。

同一 epoch／计量项的日期视图只选一套来源依据：自动采集的真实模型请求优先于原生日志推导的时间区间，不把两者相加。不限日期时，原生累计父范围仍可补足总量；如果只采到部分请求，余量保留为未定位用量，并提示覆盖缺口。例如累计 190、只捕获 70 时，日期已定位部分为 70，余下 120 不会按时间猜分。

## 登记一个上下文快照

上下文快照（Context Snapshot）是本项目定义的 `context-snapshot-v1` 文件格式，来源标识为 `context_snapshot`。它是自动采集之外的手动导入入口，不等同于某个第三方工具的原生导出。手动导入时由生产方按下述合同生成快照。

1. 在服务的 `.env` 中显式授权只供导入的目录；默认没有任何外部导入根目录。由运维创建目录并让服务用户只访问需要的文件。配置在下次服务启动生效。

   ```dotenv
   USAGE_IMPORT_ROOTS='{"manual":"/srv/remote-agent/usage-imports"}'
   ```

2. 把快照放在该目录，例如 `capture.json`。初次体验可以使用仓库内的[合成示例](examples/context-snapshot.json)，请将它绑定到专门的测试 Session，避免污染真实统计。示例已报告用量是 440；未为示例中的模型配置词表时，工具 token 使用兜底估算，输入与调用证据仍可查询。

3. 使用管理 Token 获取目标 Session 当前 epoch，再登记明确映射。下面需要 curl 和 jq；`API_TOKEN` 由操作者的 Secret 管理方式注入，示例通过 stdin 传给 curl，不放进命令参数。

   ```sh
   USAGE_BASE_URL=http://127.0.0.1:3000
   USAGE_SESSION_ID=1
   usage_api() {
     curl --silent --show-error --fail-with-body --config - "$@" <<EOF
   header = "Authorization: Bearer ${API_TOKEN:?API_TOKEN is required}"
   EOF
   }
   USAGE_EPOCH=$(usage_api "$USAGE_BASE_URL/api/usage/summary?sessionId=$USAGE_SESSION_ID" | jq -er '.providerEpochId')
   jq -n --arg session "$USAGE_SESSION_ID" --arg epoch "$USAGE_EPOCH" '{
     sourceKey: "manual-capture", kind: "context_snapshot",
     inputRef: {importRootId: "manual", relativePath: "capture.json"},
     mappings: [{sourceSessionKey: "example-capture", sessionId: $session, providerEpochId: $epoch}]
   }' > usage-registration.json
   USAGE_SOURCE_ID=$(usage_api -X POST -H 'Content-Type: application/json' \
     --data-binary @usage-registration.json "$USAGE_BASE_URL/api/usage/sources" | jq -er '.id')
   usage_api -X POST "$USAGE_BASE_URL/api/usage/sources/$USAGE_SOURCE_ID/collect"
   usage_api "$USAGE_BASE_URL/api/usage/sources"
   ```

   登记返回 201，相同配置重试返回 200，配置冲突返回 409。collect 返回 202 和持久化 collection ID；它只代表已接纳，不代表已完成。查看 sources 中该来源的 `status`，失败时显示稳定 `errorCode`；重复 collect 不会重复累加。

   管理接口按类型化错误码映射已知的 400／404／409 错误。数据库等未预期内部异常返回 500 与通用 `usage_source_failed`，不返回原始异常内容，也不把内部故障当作无效输入。

   `GET /api/usage/sources` 支持可选 `agentId`、`sessionId`，同时提供时必须匹配同一映射。界面的来源列表与轮询使用当前 Agent／Session 筛选；返回来源时仍保留该来源的完整映射。来源状态不按日期裁剪。

4. 完成后打开 `/usage?sessionId=1&range=all`（替换 Session ID），或查询：

   ```sh
   usage_api "$USAGE_BASE_URL/api/usage/summary?sessionId=$USAGE_SESSION_ID"
   usage_api "$USAGE_BASE_URL/api/usage/capabilities?sessionId=$USAGE_SESSION_ID&dimension=mcp_tool"
   usage_api "$USAGE_BASE_URL/api/usage/invocations?sessionId=$USAGE_SESSION_ID&origin=context"
   ```

   从排名查看调用或模型输入证据，再查看详情中的 `exposures` 和对应模型请求。模型输入证据直接来自持久化暴露，因此只有定义、没有执行的 MCP，以及作为标签归属的 Skill／插件也能下钻；这些证据不会增加执行次数。

Provider 文件也可显式登记 `codex_log` 或 `claude_log`。使用授权导入根目录，或以 `inputRef: {providerSessionRef: "业务SessionID", relativePath: "相对路径"}` 指向该 Session 托管的 Provider Home。Agent、原生 Session ID、路径和 epoch 均由服务核对；不能指定任意绝对路径或 URL。

## 快照合同

顶层字段为 `format`、非负整数 `revision`、`historyComplete`、`capabilities` 和 `requests`；完整例子见上文。`historyComplete` 默认 false，只有确认包含此 epoch 的相关历史时才设 true。

- `requests[].id` 与 `session_id` 是生产方稳定身份；相同内容的两次真实请求必须有两个 ID。`timestamp` 应带 UTC 或 offset；为兼容已归一化记录，未带 offset 时按 UTC 解释。
- `canonical_request_body`／`canonical_response_body` 是 JSON 字符串或 null，必须是已归并的完整对象，不是 SSE 分片。支持 Responses、Chat Completions、Anthropic Messages 的常见文本／工具结构；未知端点不形成账单总量，也不声称完整解析。
- `context_fidelity` 为 `complete`、`partial`、`opaque`；`response_complete` 表达终态。缺正文保留 `none`，未展开的 `previous_response_id`／conversation 上下文保留 partial，不按时间猜前驱。
- `capabilities[].runtimeName` 对应 payload 内的实际工具名；`capability` 包含 `id/kind/name`，MCP 还应有 `serverId`。可选 `tags` 为同一块补充 Skill／plugin 归属。未知别名保留 unknown；不会从工具显示名猜 MCP Server。
- 更新文件时保留原请求 ID、递增快照 `revision`，再 collect。旧请求的终态修订会替换旧投影；同一 revision 的内容变化不作为新观测。文件需原位更新并在 collect 前完成，替换 inode 必须用新的 sourceKey 重新登记。

## 查询和维护

共同筛选为 `agentId/sessionId/from/to/timezone/runtimeKind`。日期采用 `[from,to)`，时区为 IANA；时间趋势支持 day/week/month。首版只支持已映射主体的 `subagents=self`，不自动扫描或推断 Provider 内部子 Agent 树。

能力维度为 `mcp_tool/builtin_tool/cli/skill/plugin/hook/unknown`。排名支持 `limit`（1–200）、`offset` 以及调用数、定义输入、结果首次／重复输入、总输入贡献、失败数、P95 耗时排序。调用列表使用 `cursor`；`origin=counted` 与 `execution` 只看实际执行，`context` 只看输入证据。不同 origin 不相加。

`GET /api/usage/context-evidence` 按能力和模型请求列出输入证据，支持共同筛选以及 `capabilityId/capabilityKind/capabilityServerId`、`cursor/limit`。`GET /api/usage/context-evidence/:id` 返回对应暴露的身份、位置、字节数、估算和首次／重复归属，保留原模型请求与工具调用关联，不返回正文。该查询独立于执行列表，能解释未使用的工具定义、Skill／插件标签和未知输入来源。

Reset／存储 cleanup 先停止产生记录，冻结来源、提交尾部统计，再删除 Provider 文件；未完成时返回 `usage_collection_pending` 并保留维护状态，阻止新 Run，重试或重启继续。Reset 切换 epoch 并保留历史账本，cleanup 保留统计。显式删除 Session 撤销映射、清除其统计并拒收旧来源重放。

启动恢复会发现尚未登记的托管日志，关闭 Runtime 后再补采落盘尾部。发现或采集失败以 `collectionFailures` 保留，重试成功后清除；已删除或完成存储清理的 Session 不会被重新激活。

每文件上限 16 MiB；每上下文最多处理 2,048 块、1 MiB 可分词文本，单块上限 256 KiB。超限分词为未知且标记 partial，不用字符比例补数。采集单次限时 30 秒，同来源串行；读取失败不影响已完成的业务结果，但维护屏障失败会阻止破坏性清理。备份现有 SQLite 即包含账本；已导入正文不进入新账本，源文件仍由操作者管理。

## 性能与恢复边界

能力排名使用数据库聚合和首次结果索引，日期筛选在 SQL 中执行；输入证据先选取有界上下文候选，再生成当前页的明细。模型汇总和趋势仍读取所选主体的历史计量元数据，以保持跨来源去重、累计量及未归位统计的口径；单次查询只读取一次账本，按 Session／epoch／Run 建立临时包含关系索引，避免逐个父范围扫描全部历史。趋势复用一个时区格式化器，按时间桶累计，不再二次加载账本。这部分开销仍随历史规模增长，不是固定成本查询。排序／翻页不重新请求汇总与趋势。相同词表资产复用引擎，估算元数据通过字典去重，仍保留各 profile 和模型身份。

托管日志保存字节位置、行号及无正文解析状态，只解析新增行；仍以 64 KiB 缓冲区校验完整旧前缀，读取开销随文件大小增长，以识别原地改写。最多 100 条观测与 checkpoint 原子提交。半行与半个 UTF-8 字符留待后续重试，维护屏障不会把它们视作完整采集。新增索引和元数据字典首次启动时迁移，后续不重新计算历史。SQLite 回收页供后续复用，迁移不会自动执行全库 VACUUM。

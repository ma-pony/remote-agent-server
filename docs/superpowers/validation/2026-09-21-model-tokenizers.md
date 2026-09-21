# 多模型词表与兜底估算验证

日期：2026-09-21。当前工作区的验证；未提交、推送、部署或调用真实 Provider。

## 最终行为

- 使用 `@huggingface/tokenizers@0.2.0` 和显式本地模型／Provider 词表，已移除 js-tiktoken 生产依赖。没有引入 gpt-tokenizer。
- 未匹配模型或模型名缺失时自动使用 `unicode-weighted-v1`，默认不配置词表也可查看工具 token 排名。前端标注“兜底估算”；中文、代码符号、Emoji 使用不同字符权重。它是方向性估计，未声明准确率或误差区间。
- 每项保存模型、方法、词表或兜底版本及原因。混合来源保留分项和近似总输入供排名。已有计数不因更换配置而重算；旧参考编码计数仍标为 `legacy_reference`。
- Provider 上报用量独立去重，不与工具估算相加。未采集正文、不支持的模态及大小上限仍保留缺口。

## 自动化验证

- `corepack pnpm test --maxWorkers=4`：**77 个文件通过，1 个文件跳过；1008 项通过，17 项跳过**。
- `corepack pnpm typecheck`：服务、前端、脚本通过。
- `corepack pnpm build`：服务与生产前端构建通过。
- `git diff --check`：通过。
- 回归覆盖精确模型／Provider 选择、不同词表与缓存隔离、普通特殊标记、Unicode 与空文本、文件哈希验证、历史迁移、模型切换保留历史、混合与兜底排名、默认配置导入 API、前端标记与排序。
- 确实观察到失败后修复的用例：旧未知模型合同、响应实际模型优先、流式模型字段传播、兜底计数／混合合计及前端说明。并非每个新增测试都经历了单独红绿过程。

## 实际前后端验收

使用隔离的临时数据库与目录、Fake Runtime、真实 Fastify／SQLite／快照导入 API 和本次生产构建的浏览器页面，`USAGE_TOKENIZERS=[]`。所有种子 Workspace 路径在应用初始化前改到该临时根目录。

经注册来源 → collect → 持久化 → 查询 API → 浏览器登录与 Session 页面展示，实际读到：

| 项目 | API 与页面结果 |
| --- | --- |
| 模型上报总量 | 280（输入 250，输出 30） |
| MCP search 估算输入 | 27（定义 24，首次结果 3） |
| 输入字节数 | 81 |
| 方法 | 兜底估算（按字符类型加权），unicode-weighted-v1 |
| 原因 | 未配置模型词表 |
| 调用事实 | 实际执行 0，上下文证据 1；未将快照证据伪装成执行 |

浏览器已关闭，临时服务端口已释放。这证明本地前后端和持久化合同，**不证明真实 Provider 流程或账单准确率**。

## 公开真实词表交叉验证

只下载公开 tokenizer.json 与 tokenizer_config.json，不下载模型权重、不进行推理。通过实际 `loadModelTokenizers` 加载固定资产，与 Python `tokenizers==0.23.1` 的 Rust 实现逐项比较；两边均移除特殊 added_tokens 且禁用每块 BOS/EOS 插入。

| 模型 | 固定 revision |
| --- | --- |
| google-bert/bert-base-uncased | `86b5e0934494bd15c9632b12f734a8a67f723594` |
| Qwen/Qwen2.5-0.5B | `060db6499f32faf8b98477b0a26969ef7d8b9987` |

| 文本 | BERT WordPiece | Qwen BPE | 通用兜底 |
| --- | ---: | ---: | ---: |
| `Hello, world!` | 4 | 4 | 4 |
| `你好，世界！` | 6 | 4 | 6 |
| `const x = 42;\nconsole.log(x);` | 13 | 11 | 9 |
| `{"city":"Paris"}` | 9 | 5 | 6 |
| `👩‍💻🚀` | 1 | 5 | 7 |
| `é café` | 2 | 2 | 4 |
| `[CLS] <&#124;endoftext&#124;>` | 12 | 9 | 7 |
| `（空文本）` | 0 | 0 | 0 |

**两个真实词表的 16 项计数全部与 Rust 实现一致。** 兜底列用于展示不同计量方法的差异，未用这 8 个短样本拟合系数或推断普遍准确率。BERT 用于验证 WordPiece 引擎；它不是 Claude 等闭源模型的替代词表。

固定资产 SHA-256：

- `google-bert/bert-base-uncased`：
  - [tokenizer.json](https://huggingface.co/google-bert/bert-base-uncased/resolve/86b5e0934494bd15c9632b12f734a8a67f723594/tokenizer.json)：`ce64fce797c24f68df90b40a3f74f579b336a493db14bd583fd520ea0d8c9a98`（466062 bytes）
  - [tokenizer_config.json](https://huggingface.co/google-bert/bert-base-uncased/resolve/86b5e0934494bd15c9632b12f734a8a67f723594/tokenizer_config.json)：`a025160ef0431f1a392f6f050c1310f4c5d9fb6f275932dbccba73c4d214bf10`（48 bytes）
- `Qwen/Qwen2.5-0.5B`：
  - [tokenizer.json](https://huggingface.co/Qwen/Qwen2.5-0.5B/resolve/060db6499f32faf8b98477b0a26969ef7d8b9987/tokenizer.json)：`c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539`（7031645 bytes）
  - [tokenizer_config.json](https://huggingface.co/Qwen/Qwen2.5-0.5B/resolve/060db6499f32faf8b98477b0a26969ef7d8b9987/tokenizer_config.json)：`c91efca15ceff6e9ee9424db58a6f59cd41294e550a86cbd07e3c1fb500b34f9`（7228 bytes）

公开词表和验证输出保留在忽略目录 `.superpowers/sdd/2026-09-21-model-tokenizers/`；没有作为生产默认词表打包。

## 最终审核与裁定

按 Superpowers executing-plans 做了一轮独立只读审核，发现一项重要问题：Chat Completions SSE 丢弃实际 `model`，可能让别名选错词表。已修复保留非空 model，并添加流式解码 → 归一化 → Provider 限定词表选择回归，先复现失败后通过。

审核后用户明确要求未知模型必须兜底，遂更新计量合同并增加后端、API、前端测试和实际页面验收；该后续增量由执行者审核，未声称独立审核覆盖了该增量。

审核明确未判断真实 Provider 兼容性、账单准确率，且没有重复运行执行者的全量测试和词表对照。裁定：保留这些验证边界；当前报告只依据本工作区实际执行结果。

参考思路来自 [LangChain 近似计数](https://github.com/langchain-ai/langchain/blob/master/libs/langchain_v1/langchain/agents/middleware/summarization.py)及 [DeepSeek Harness token meter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/token-meter/README.md)对 heuristic 与 reported 的区分；没有复制其源代码或增加这些框架依赖。

## 未完成的外部验证

未执行真实 Provider smoke、计费端对照、Claude／Gemini 最新模型词表一致性验证，亦未启用远程 token-count API。词表正确性仅覆盖上述固定资产与样本，兜底可用于优化排序但不提供账单精度保证。

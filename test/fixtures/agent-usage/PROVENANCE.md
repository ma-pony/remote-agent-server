# Usage observability provenance

All fixtures are synthetic and contain no user payloads, credentials, Provider home files or captured traffic.

| Unit | Reference | Adoption |
| --- | --- | --- |
| Provider JSONL profiles | [Provider log provenance](provider-logs/PROVENANCE.md) | Independently written narrow parsers; fixed source references and semantics recorded there. |
| Canonical context snapshot | ContextSpy commit `11aa95827fd1a7970595cdfeb689b5c3ce1b0919`, `docs/transport-normalization.md`, `contextspy/api/routers/requests.py`, `contextspy/db/models.py` (Apache-2.0) | Request/response normalization, explicit identity and fidelity concepts informed the design. No source code copied and no runtime dependency/integration. `context-snapshot-v1` is our own format, not an upstream export. |
| Text estimates | [`@huggingface/tokenizers@0.2.0`](https://github.com/huggingface/tokenizers.js), Apache-2.0 | Reuse the independent engine with explicitly bound local vocabularies; no model-specific fallback and no remote counting request. BPE caches of raw text are disabled. |
| MCP observation | Already installed `@modelcontextprotocol/server` and `client` 2.0.0 | Existing forwarding/filter transport reused with a private local metadata channel. No external telemetry backend. |

The independently written context parser supports selected normalized Responses, Chat Completions and Anthropic Messages text/tool structures. It does not implement transport interception, streaming reassembly, complete third-party export compatibility, or automatic predecessor reconstruction. Parser, replay and source API tests define the supported subset. Changes to source schemas require new fixtures and semantic validation before claiming support.

The files under `tokenizers/` are independently authored synthetic WordPiece fixtures. Attribution tests explicitly bind synthetic model IDs (including historical fixture names such as `gpt-test`) to this test vocabulary; these are not production model mappings. Two fixture vocabularies deliberately segment the same text differently to verify model selection and cache separation. Migration tests preserve historical js-tiktoken metadata without loading that package. No tokenizer or framework source code was copied.

Public Qwen and BERT tokenizer assets used for local cross-implementation verification remain in the ignored verification workspace; their fixed revisions, checksums, and results are recorded in the validation report. They are not bundled as production defaults.

Fallback design reference: [LangChain approximate counting](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/messages/utils.py) and [DeepSeek Harness token meter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/token-meter/README.md) use separately identified heuristics. We borrow that separation, not source code or framework dependencies. `unicode-weighted-v1` is our independently authored directional rule; its script weights are not claimed to reproduce either framework or to have a measured accuracy guarantee.

# Multi-model token measurement implementation

The user's continuation approves replacing the GPT-only reference counter with the proposed Hugging Face engine and explicit model registry. Existing Agent Usage capture/accounting remains the foundation. No commit, push, deployment, service restart or live Provider call is authorized.

## Contract

- Use `@huggingface/tokenizers@0.2.0` (Apache-2.0); remove the js-tiktoken dependency. Borrow routing and provenance ideas from LiteLLM/Langfuse, without copying their tokenizer fallback logic or adding their frameworks.
- `USAGE_TOKENIZERS` is an optional array of profiles with an ID, exact model IDs, optional model-provider identity, and absolute local tokenizer/config paths plus SHA-256 hashes. No implicit vocabulary substitution or runtime download. Load and validate bounded files once at startup. Per the later explicit user correction, unconfigured or missing models use a versioned Unicode-weighted fallback, retaining byte/call evidence and a rankable approximate count.
- Count each visible text block using its resolved model profile, without injected BOS/EOS tokens. Literal special markers are ordinary content. Cache hashes/counts only, including profile revision. Unsupported content, size limits and tokenizer failures remain explicit gaps.
- Persist estimate provenance per exposure. Existing counts migrate as `legacy_reference` with their original js-tiktoken/o200k identity. New registry configuration never rewrites old counts.
- Ranking rows include per-model/profile breakdowns. Mixed profiles and fallback counts produce an explicitly approximate subtotal for ranking; per-model/method breakdowns remain available. Unsupported or absent content remains a gap. Calls, bytes, first/repeated use, Session/Agent/date filters and reported usage keep their semantics.
- The UI explains fallback/mixed counts and exposes profile/model provenance. It must not label an available input with an unmapped model as uncaptured input.

## Task 1: Engine and model registry

Add deterministic local WordPiece fixtures and validate public BPE assets and tests for different model vocabularies, exact matching, provider identity, missing models, Unicode, special markers, caps and revision-aware caching. Watch a regression fail before replacing the counter. Validate local assets at startup and integrate configuration into the existing managed collector construction. Expected: focused engine tests pass; no network call during tokenization.

## Task 2: Persistence, ranking and UI

Add migration, restart, mixed-profile, unknown-model and request-level regression tests. Persist metadata with each exposure and surface it through rankings and detail APIs; adapt existing count fixtures to explicit test profiles. Update bilingual UI and interaction tests. Expected: known/missing/mixed/legacy states remain distinguishable and all existing lifecycle/accounting tests retain their behavior.

## Task 3: Documentation and verification

Update public docs, configuration examples and fixture provenance. Validate two real public model tokenizer assets locally (no model inference), then run focused tests, full suite, typecheck, production build and diff check. Fresh-context final review checks privacy/cache retention, special-token handling, model identity, bounded loading, mixed ranking, migration and test coverage. Fix material findings and verify again.

## Progress and rulings

- Pre-flight: engine metadata is persisted by the store and consumed by the UI; agree on the complete provenance shape before changing these consumers.
- Ruling: continue inline in the already requested current checkout; existing coupled edits and untracked feature files must be preserved. A fresh reviewer is used after implementation under Superpowers executing-plans.
- Ruling: official remote token-count endpoints remain an optional future adapter. This change implements offline model-specific counting, and does not add credential handling or transmit captured content for estimation.
- Ruling: assets are read synchronously only during existing synchronous application construction, with regular-file and byte limits; no file reads occur in the per-request counter. This preserves the current application factory contract.

- User correction: unknown models must have fallback values. The default Unicode-weighted heuristic is explicit and versioned; mixed estimates keep approximate numeric subtotals for ranking. This supersedes the initial null-subtotal and no-fallback rulings.
- Final verification: 1008 passed / 17 skipped, typecheck/build/diff check passed; 16 real-vocabulary counts match Rust tokenizers. Default-profile import API and actual browser page show fallback counts. Independent review finding (chat SSE model identity) fixed. See [validation](../validation/2026-09-21-model-tokenizers.md).

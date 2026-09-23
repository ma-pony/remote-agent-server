import { automaticTokenizerProfiles } from "../../../../src/agent-usage/core/tokenizer-catalog.js";
import { fixtureTokenizerConfig } from "./helpers.js";

// This module runs only in the test worker; no network or production vocabulary is needed.
const fixture = fixtureTokenizerConfig();
Object.assign(automaticTokenizerProfiles[0]!, {
  tokenizerSha256: fixture.tokenizerSha256, configSha256: fixture.configSha256
});
globalThis.fetch = async () => { throw new Error("Unexpected tokenizer download"); };
export { ModelTokenizers } from "../../../../src/agent-usage/core/tokenizers.js";

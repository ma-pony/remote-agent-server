import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelTokenizers } from "../../../../src/agent-usage/core/tokenizers.js";

const root = new URL("./", import.meta.url);
export const fixtureTokenizerConfig = () => {
  const tokenizerPath = fileURLToPath(new URL("tokenizer.json", root));
  const configPath = fileURLToPath(new URL("tokenizer_config.json", root));
  return { id: "fixture", models: ["gpt-4.1", "fixture-model", "gpt-test", "fixture", "synthetic-model", "synthetic-gpt-model"], tokenizerPath, configPath,
    tokenizerSha256: createHash("sha256").update(readFileSync(tokenizerPath)).digest("hex"),
    configSha256: createHash("sha256").update(readFileSync(configPath)).digest("hex") };
};
export const fixtureProfile = (id = "fixture", models = fixtureTokenizerConfig().models) => ({
  id, models,
  tokenizerJson: JSON.parse(readFileSync(new URL("tokenizer.json", root), "utf8")),
  tokenizerConfig: JSON.parse(readFileSync(new URL("tokenizer_config.json", root), "utf8"))
});
export const fixtureTokenizers = () => new ModelTokenizers([fixtureProfile()]);

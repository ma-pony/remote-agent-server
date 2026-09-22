import type { AutomaticTokenizerProfile } from "./tokenizer-assets.js";

/** Verified public vocabulary assets; aliases never select arbitrary URLs or executable model code. */
export const automaticTokenizerProfiles: readonly AutomaticTokenizerProfile[] = [
  {
    id: "deepseek-v41-flash",
    // DeepSeek's 2026-09-10 release maps deepseek-flash to V4.1 Flash.
    // Keep older version names explicit rather than reinterpreting historical records.
    models: ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-ai/DeepSeek-V4.1-Flash"],
    repository: "deepseek-ai/DeepSeek-V4.1-Flash",
    revision: "dba1be0a40aa45a94ad051997016db3960a90277",
    tokenizerSha256: "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
    configSha256: "6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547"
  },
  {
    id: "qwen25-05b",
    models: ["Qwen/Qwen2.5-0.5B"],
    repository: "Qwen/Qwen2.5-0.5B",
    revision: "060db6499f32faf8b98477b0a26969ef7d8b9987",
    tokenizerSha256: "c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
    configSha256: "c91efca15ceff6e9ee9424db58a6f59cd41294e550a86cbd07e3c1fb500b34f9"
  }
];

export const automaticTokenizerProfile = (model: string): AutomaticTokenizerProfile | undefined =>
  automaticTokenizerProfiles.find(profile => profile.models.includes(model));

import type { ToolContentEstimate } from "./context-types.js";
import { ModelTokenizers, type TokenCount } from "./tokenizers.js";

const fallback = new ModelTokenizers();
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
type ContentText = { text: string; partial: boolean };

const unwrapBlock = (value: unknown): Record<string, unknown> | undefined => {
  const record = object(value);
  return record?.type === "content" ? object(record.content) : record;
};
const isBlock = (value: unknown): boolean => {
  const block = unwrapBlock(value);
  if (!block) return false;
  switch (block.type) {
    case "text": return typeof block.text === "string";
    case "image": case "audio": return typeof block.data === "string" || object(block.source) !== undefined;
    case "resource": return object(block.resource) !== undefined;
    case "resource_link": return typeof block.uri === "string";
    case "diff": return typeof block.oldText === "string" || typeof block.newText === "string";
    case "terminal": return typeof block.terminalId === "string";
    default: return false;
  }
};
const blockText = (value: unknown): ContentText => {
  const block = unwrapBlock(value)!;
  if (block.type === "text") return { text: block.text as string, partial: false };
  if (block.type === "resource" && typeof object(block.resource)?.text === "string") {
    return { text: object(block.resource)!.text as string, partial: false };
  }
  if (block.type === "diff") return {
    text: [block.oldText, block.newText].filter((entry): entry is string => typeof entry === "string").join("\n"), partial: false
  };
  return { text: "", partial: true };
};

// Ordinary JSON retains its shape; recognized nested media never contributes base64 as text.
const jsonText = (value: unknown): ContentText => {
  let partial = false;
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (isBlock(entry) && blockText(entry).partial) { partial = true; return null; }
    return entry;
  });
  return { text: text ?? "", partial };
};

/** Only explicit MCP/ACP block shapes are envelopes; JSON arrays are ordinary results. */
const resultText = (value: unknown): ContentText => {
  if (typeof value === "string") return { text: value, partial: false };
  if (isBlock(value)) return blockText(value);
  const record = object(value);
  const blocks = Array.isArray(value) && value.length > 0 && value.every(isBlock) ? value
    : Array.isArray(record?.content) && record.content.every(isBlock) ? record.content : undefined;
  if (blocks) {
    const contents = blocks.map(blockText);
    const partial = contents.some((content) => content.partial);
    const texts = contents.filter((content) => !content.partial).map((content) => content.text);
    if (!texts.length && record?.structuredContent !== undefined) {
      const structured = jsonText(record.structuredContent);
      return { text: structured.text, partial: partial || structured.partial };
    }
    return { text: texts.join("\n"), partial };
  }
  return jsonText(record?.structuredContent !== undefined ? record.structuredContent : value);
};

export const measureToolContent = async (
  value: unknown, part: "arguments" | "result", tokenizers = fallback,
  model: string | null = null, modelProvider: string | null = null, signal?: AbortSignal
): Promise<ToolContentEstimate | undefined> => {
  signal?.throwIfAborted();
  if (value === undefined) return undefined;
  try {
    const content = part === "result" ? resultText(value)
      : typeof value === "string" ? { text: value, partial: false } : jsonText(value);
    const byteLength = Buffer.byteLength(content.text);
    if (content.partial && content.text.length === 0) return { tokens: null, byteLength, partial: true,
      estimate: { ...fallback.describe(model, modelProvider), method: "unavailable", reason: "unsupported_content" } };
    let counted: TokenCount;
    try { counted = await tokenizers.countAsync(content.text, model, modelProvider, signal); }
    catch {
      signal?.throwIfAborted();
      counted = { ...tokenizers.describe(model, modelProvider), method: "unavailable", tokens: null, reason: "tokenization_failed" };
    }
    if (counted.tokens === null && !tokenizers.hasVocabulary(model, modelProvider)) {
      const reason = counted.reason ?? "tokenization_failed";
      counted = { ...await fallback.countAsync(content.text, model, modelProvider, signal), reason };
    }
    const { tokens, ...estimate } = counted;
    return { tokens, byteLength, estimate, partial: content.partial };
  } catch {
    signal?.throwIfAborted();
    // Observability must never fail the tool call (cycles, exotic getters, etc.).
    return undefined;
  }
};

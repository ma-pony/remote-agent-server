import { z } from "zod";

export type WebhookScalar = string | number | boolean | null;
export type WebhookCondition =
  | { field: string; op: "eq" | "neq"; valueField: string }
  | { field: string; op: "eq" | "neq" | "contains" | "not_contains"; value: WebhookScalar }
  | { field: string; op: "in" | "not_in"; value: WebhookScalar[] }
  | { field: string; op: "exists"; value: boolean };
export type WebhookFilter = WebhookCondition | { all: WebhookFilter[] } | { any: WebhookFilter[] };
export type WebhookFilterEvent = { eventType: string; payload: Record<string, unknown> };
export type WebhookFilterCheck = { path: string; field: string; op: WebhookCondition["op"]; valueField?: string; matched: boolean;
  reason: "matched" | "value_mismatch" | "missing_field" | "type_mismatch" };
export type WebhookFilterResult = { matched: boolean; checks: WebhookFilterCheck[] };

const scalarType = (value: unknown): string => value === null ? "null" : typeof value;
const scalarSchema = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);
const fieldSchema = z.string().max(256).regex(/^(eventType|payload(?:\.(?:[A-Za-z0-9_-]+|\*))+)$/)
  .refine((path) => path.split("*").length <= 2)
  .refine((path) => !path.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)));
const conditionSchema = z.union([
  z.object({ field: fieldSchema, op: z.enum(["eq", "neq"]), valueField: fieldSchema }).strict(),
  z.object({ field: fieldSchema, op: z.enum(["eq", "neq", "contains", "not_contains"]), value: scalarSchema }).strict(),
  z.object({ field: fieldSchema, op: z.enum(["in", "not_in"]), value: z.array(scalarSchema).min(1).max(100)
    .refine((values) => values.every((value) => scalarType(value) === scalarType(values[0]))) }).strict(),
  z.object({ field: fieldSchema, op: z.literal("exists"), value: z.boolean() }).strict()
]);
const ruleSchema: z.ZodType<WebhookFilter> = z.lazy(() => z.union([
  conditionSchema,
  z.object({ all: z.array(ruleSchema).min(1).max(50) }).strict(),
  z.object({ any: z.array(ruleSchema).min(1).max(50) }).strict()
]));

// Bound work before recursive validation, including malformed or excessively deep input.
export const webhookFilterSchema = z.unknown().superRefine((input, context) => {
  const pending = [{ value: input, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++count > 50 || depth > 6) {
      context.addIssue({ code: "custom", message: "At most 50 filter nodes and 6 nested groups are allowed" });
      return;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const key of ["all", "any"] as const) {
      if (!Object.hasOwn(value, key)) continue;
      const children = (value as Record<string, unknown>)[key];
      if (!Array.isArray(children)) continue;
      if (children.length > 50) {
        context.addIssue({ code: "custom", message: "At most 50 filter nodes are allowed" });
        return;
      }
      pending.push(...children.map((child) => ({ value: child, depth: depth + 1 })));
    }
  }
}).pipe(ruleSchema);

export const webhookFieldValue = (event: WebhookFilterEvent, path: string): unknown => {
  const read = (input: unknown, parts: string[]): unknown => {
    let value = input;
    for (let index = 0; index < parts.length; index++) {
      const segment = parts[index]!;
      if (segment === "*") return Array.isArray(value) ? value.map((item) => read(item, parts.slice(index + 1))) : undefined;
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
  return read(event, path.split("."));
};

/** Pure, bounded evaluation. No coercion, scripts, regular expressions, I/O, or model calls. */
export const evaluateWebhookFilter = (filter: WebhookFilter | null, event: WebhookFilterEvent): WebhookFilterResult => {
  const checks: WebhookFilterCheck[] = [];
  const visit = (rule: WebhookFilter, path: string): boolean => {
    if ("all" in rule || "any" in rule) {
      const mode = "all" in rule ? "all" : "any";
      const children = "all" in rule ? rule.all : rule.any;
      const results = children.map((child, index) => visit(child, `${path}.${mode}.${index}`));
      return mode === "all" ? results.every(Boolean) : results.some(Boolean);
    }
    const actual = webhookFieldValue(event, rule.field);
    let matched = false;
    let reason: WebhookFilterCheck["reason"] = "value_mismatch";
    if ("valueField" in rule) {
      const expected = webhookFieldValue(event, rule.valueField);
      if (actual === undefined || expected === undefined) reason = "missing_field";
      else if (scalarType(actual) !== scalarType(expected) || !["string", "number", "boolean", "null"].includes(scalarType(actual))) {
        reason = "type_mismatch";
      } else matched = rule.op === "eq" ? actual === expected : actual !== expected;
    } else if (rule.op === "exists") {
      const exists = rule.field.includes("*") && Array.isArray(actual)
        ? actual.some((value) => value !== undefined) : actual !== undefined;
      matched = exists === rule.value;
    } else if (actual === undefined) {
      reason = "missing_field";
    } else if (rule.op === "contains" || rule.op === "not_contains") {
      if (!Array.isArray(actual)) reason = "type_mismatch";
      else if (rule.op === "not_contains" && actual.some((value) => value === undefined)) reason = "missing_field";
      else if (rule.op === "not_contains" && actual.some((value) => scalarType(value) !== scalarType(rule.value))) reason = "type_mismatch";
      else {
        const included = actual.some((value) => value === rule.value);
        matched = rule.op === "not_contains" ? !included : included;
      }
    } else {
      const values = Array.isArray(rule.value) ? rule.value : [rule.value];
      if (scalarType(actual) !== scalarType(values[0]) || (actual !== null && typeof actual === "object")) {
        reason = "type_mismatch";
      } else {
        const included = values.some((value) => value === actual);
        matched = rule.op === "neq" || rule.op === "not_in" ? !included : included;
      }
    }
    checks.push({ path, field: rule.field, op: rule.op, ...("valueField" in rule ? { valueField: rule.valueField } : {}),
      matched, reason: matched ? "matched" : reason });
    return matched;
  };
  return { matched: filter === null || visit(filter, "$"), checks };
};

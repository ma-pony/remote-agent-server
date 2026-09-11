import { describe, expect, it } from "vitest";

import { evaluateWebhookFilter, webhookFilterSchema } from "../src/integrations/webhook-filter.js";
import { listWebhookProviders } from "../src/integrations/webhook-adapters/index.js";

describe("Webhook filter semantics", () => {
  it.each([
    [{ field: "payload.labels.*.title", op: "contains", value: "CodeReview" }, { labels: [{ title: "other" }, { title: "CodeReview" }] }, true],
    [{ field: "payload.labels.*.title", op: "contains", value: "CodeReview" }, { labels: [{ other: "CodeReview" }] }, false],
    [{ field: "payload.labels", op: "contains", value: "CodeReview" }, { labels: ["other", "CodeReview"] }, true],
    [{ field: "payload.labels", op: "contains", value: "CodeReview" }, { labels: "CodeReview" }, false],
    [{ field: "payload.ids", op: "contains", value: 101 }, { ids: ["101"] }, false],
    [{ field: "payload.labels.*.title", op: "contains", value: "CodeReview" }, {}, false],
    [{ field: "payload.id", op: "eq", value: 0 }, { id: 0 }, true],
    [{ field: "payload.id", op: "neq", value: 1 }, { id: 0 }, true],
    [{ field: "payload.id", op: "neq", value: 1 }, {}, false],
    [{ field: "payload.id", op: "not_in", value: [1] }, { id: "2" }, false],
    [{ field: "payload.id", op: "eq", value: null }, { id: null }, true],
    [{ field: "payload.id", op: "eq", value: null }, {}, false],
    [{ field: "payload.id", op: "exists", value: true }, { id: null }, true],
    [{ field: "payload.id", op: "exists", value: false }, { id: null }, false],
    [{ field: "payload.labels.*.title", op: "exists", value: true }, { labels: [{ id: 1 }] }, false],
    [{ field: "payload.labels.*.title", op: "exists", value: false }, { labels: [{ id: 1 }] }, true],
    [{ field: "payload.labels.*.title", op: "exists", value: true }, { labels: [] }, false],
    [{ field: "payload.labels.*.title", op: "exists", value: false }, { labels: [] }, true],
    [{ field: "payload.labels.*.title", op: "exists", value: true }, {}, false],
    [{ field: "payload.labels.*.title", op: "exists", value: false }, {}, true],
    [{ field: "payload.labels.*.title", op: "exists", value: true }, { labels: [{ id: 1 }, { title: null }] }, true],
    [{ field: "payload.labels.*.title", op: "exists", value: false }, { labels: [{ id: 1 }, { title: "CodeReview" }] }, false],
    [{ field: "payload.labels", op: "exists", value: true }, { labels: [] }, true],
    [{ field: "payload.active", op: "in", value: [false] }, { active: false }, true],
    [{ field: "payload.name", op: "in", value: ["Human"] }, { name: "human" }, false],
    [{ field: "payload.labels.0.title", op: "eq", value: "review" }, { labels: [{ title: "review" }] }, true],
    [{ field: "payload.id", op: "not_in", value: [null] }, { id: {} }, false],
    [{ any: [{ field: "payload.id", op: "eq", value: 1 }, { all: [
      { field: "payload.active", op: "eq", value: true }, { field: "payload.id", op: "eq", value: 2 }
    ] }] }, { id: 2, active: true }, true],
    [{ any: [{ field: "payload.id", op: "eq", value: 1 }, { all: [
      { field: "payload.active", op: "eq", value: true }, { field: "payload.id", op: "eq", value: 2 }
    ] }] }, { id: 2, active: false }, false]
  ])("evaluates %j against %j as %s", (rule, payload, matched) => {
    const filter = webhookFilterSchema.parse(rule);
    expect(evaluateWebhookFilter(filter, { eventType: "test", payload }).matched).toBe(matched);
  });

  it("rejects nested array scans and array/object containment values", () => {
    for (const rule of [
      { field: "payload.groups.*.labels.*.title", op: "contains", value: "CodeReview" },
      { field: "payload.labels", op: "contains", value: ["CodeReview"] },
      { field: "payload.labels", op: "contains", value: { title: "CodeReview" } }
    ]) expect(webhookFilterSchema.safeParse(rule).success).toBe(false);
  });

  it("does not inspect inherited payload properties", () => {
    const payload = Object.create({ id: 101 }) as Record<string, unknown>;
    expect(evaluateWebhookFilter({ field: "payload.id", op: "neq", value: 900 }, { eventType: "test", payload }))
      .toMatchObject({ matched: false, checks: [{ reason: "missing_field" }] });
  });
});

describe("Review event presets", () => {
  const preset = (provider: string) => webhookFilterSchema.parse(listWebhookProviders().find((item) => item.id === provider)!.filterPresets[0]!.filter);
  it.each([
    [{ action: "open" }, {}, true],
    [{ action: "reopen" }, {}, true],
    [{ action: "update", oldrev: "a".repeat(40) }, {}, true],
    [{ action: "update", oldrev: "" }, {}, false],
    [{ action: "update", oldrev: null }, {}, false],
    [{ action: "update" }, { draft: { previous: true, current: false } }, true],
    [{ action: "update", draft: undefined, work_in_progress: false }, { work_in_progress: { previous: true, current: false } }, true],
    [{ action: "update" }, { title: { previous: "A", current: "B" } }, false],
    [{ action: "approved" }, {}, false],
    [{ action: "merge", state: "merged" }, {}, false],
    [{ action: "close", state: "closed" }, {}, false],
    [{ action: "open", draft: true }, {}, false],
    [{ action: "open", draft: undefined, work_in_progress: undefined }, {}, false],
    [{ action: "update", draft: true, oldrev: "a".repeat(40) }, {}, false]
  ])("GitLab handles attributes %j changes %j as %s", (attributes, changes, matched) => {
    const payload = JSON.parse(JSON.stringify({ object_kind: "merge_request", object_attributes: {
      state: "opened", draft: false, ...attributes
    }, changes })) as Record<string, unknown>;
    expect(evaluateWebhookFilter(preset("gitlab"), { eventType: "Merge Request Hook", payload }).matched).toBe(matched);
  });

  it.each([
    ["opened", "open", false, true], ["reopened", "open", false, true], ["synchronize", "open", false, true],
    ["ready_for_review", "open", false, true], ["edited", "open", false, false], ["closed", "closed", false, false],
    ["opened", "open", true, false], ["review_requested", "open", false, false]
  ])("GitHub handles %s %s draft=%s as %s", (action, state, draft, matched) => {
    expect(evaluateWebhookFilter(preset("github"), { eventType: "pull_request", payload: { action, pull_request: { state, draft } } }).matched).toBe(matched);
  });
});

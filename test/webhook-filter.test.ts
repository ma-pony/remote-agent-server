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

  it.each([
    [{ labels: [{ title: "CodeReview" }] }, true, "matched"],
    [{ labels: [{ title: "CodeReview" }, { title: "Done-Pass" }] }, false, "value_mismatch"],
    [{ labels: [{ title: "Done-Pass" }, { title: "CodeReview" }] }, false, "value_mismatch"],
    [{ labels: [{ title: "done-pass" }] }, true, "matched"],
    [{ labels: [] }, true, "matched"],
    [{}, false, "missing_field"],
    [{ labels: "Done-Pass" }, false, "missing_field"],
    [{ labels: [{ title: "CodeReview" }, {}] }, false, "missing_field"],
    [{ labels: [{ title: "CodeReview" }, { title: 42 }] }, false, "type_mismatch"],
    [{ labels: [{ title: null }] }, false, "type_mismatch"],
    [{ labels: [{ title: ["Done-Pass"] }] }, false, "type_mismatch"]
  ])("not_contains fails closed for malformed label projections: %j", (payload, matched, reason) => {
    const filter = webhookFilterSchema.parse({ field: "payload.labels.*.title", op: "not_contains", value: "Done-Pass" });
    expect(evaluateWebhookFilter(filter, { eventType: "Merge Request Hook", payload })).toMatchObject({
      matched, checks: [{ reason }]
    });
  });

  it.each([
    [[101, 102], 900, true, "matched"],
    [[101, 900], 900, false, "value_mismatch"],
    [["900"], 900, false, "type_mismatch"],
    [[false], true, true, "matched"],
    [[null], null, false, "value_mismatch"],
    ["CodeReview", "Done-Pass", false, "type_mismatch"],
    [null, "Done-Pass", false, "type_mismatch"]
  ])("not_contains compares scalar array values without coercion: %j", (values, value, matched, reason) => {
    const filter = webhookFilterSchema.parse({ field: "payload.values", op: "not_contains", value });
    expect(evaluateWebhookFilter(filter, { eventType: "test", payload: { values } })).toMatchObject({
      matched, checks: [{ reason }]
    });
  });

  it("rejects nested array scans and array/object containment values", () => {
    for (const rule of [
      { field: "payload.groups.*.labels.*.title", op: "contains", value: "CodeReview" },
      { field: "payload.labels", op: "contains", value: ["CodeReview"] },
      { field: "payload.labels", op: "contains", value: { title: "CodeReview" } },
      { field: "payload.labels", op: "not_contains", value: ["Done-Pass"] },
      { field: "payload.labels", op: "not_contains", value: { title: "Done-Pass" } }
    ]) expect(webhookFilterSchema.safeParse(rule).success).toBe(false);
  });

  it("does not inspect inherited payload properties", () => {
    const payload = Object.create({ id: 101 }) as Record<string, unknown>;
    expect(evaluateWebhookFilter({ field: "payload.id", op: "neq", value: 900 }, { eventType: "test", payload }))
      .toMatchObject({ matched: false, checks: [{ reason: "missing_field" }] });
  });
});

describe("Webhook field comparisons", () => {
  it.each([
    [101, 101, true, "matched"], [101, 102, false, "value_mismatch"],
    ["developer", "developer", true, "matched"], ["Developer", "developer", false, "value_mismatch"],
    [false, false, true, "matched"], [false, true, false, "value_mismatch"],
    [0, 0, true, "matched"], ["", "", true, "matched"], [null, null, true, "matched"],
    [101, "101", false, "type_mismatch"], [null, 101, false, "type_mismatch"],
    [undefined, 101, false, "missing_field"], [101, undefined, false, "missing_field"],
    [undefined, undefined, false, "missing_field"],
    [[101], [101], false, "type_mismatch"], [{ id: 101 }, { id: 101 }, false, "type_mismatch"]
  ])("compares two scalar fields without coercion: %j vs %j", (left, right, equal, reason) => {
    for (const op of ["eq", "neq"] as const) {
      const filter = webhookFilterSchema.parse({ field: "payload.user.id", op, valueField: "payload.merge_request.author_id" });
      const matched = reason === "matched" || reason === "value_mismatch" ? (op === "eq" ? equal : !equal) : false;
      expect(evaluateWebhookFilter(filter, { eventType: "Note Hook", payload: { user: { id: left }, merge_request: { author_id: right } } }))
        .toEqual({ matched, checks: [{ path: "$", field: "payload.user.id", op, valueField: "payload.merge_request.author_id",
          matched, reason: matched ? "matched" : reason === "matched" ? "value_mismatch" : reason }] });
    }
  });

  it("supports event fields and nested groups while retaining literal path strings", () => {
    const rule = webhookFilterSchema.parse({ all: [
      { field: "eventType", op: "eq", valueField: "payload.event" },
      { any: [{ field: "payload.text", op: "eq", value: "payload.event" },
        { field: "payload.id", op: "neq", valueField: "payload.author_id" }] }
    ] });
    expect(evaluateWebhookFilter(rule, { eventType: "Note Hook", payload: { event: "Note Hook", text: "payload.event" } }).matched).toBe(true);
  });

  it("fails closed for inherited or array-valued field references", () => {
    const inherited = Object.create({ author_id: 101 }) as Record<string, unknown>;
    for (const op of ["eq", "neq"] as const) {
      const rule = webhookFilterSchema.parse({ field: "payload.user.id", op, valueField: "payload.merge_request.author_id" });
      expect(evaluateWebhookFilter(rule, { eventType: "Note Hook", payload: { user: { id: 101 }, merge_request: inherited } }))
        .toMatchObject({ matched: false, checks: [{ reason: "missing_field" }] });
      for (const fields of [
        { field: "payload.ids.*", valueField: "payload.id" },
        { field: "payload.id", valueField: "payload.ids.*" }
      ]) {
        expect(evaluateWebhookFilter(webhookFilterSchema.parse({ ...fields, op }), { eventType: "test", payload: { ids: [101], id: 101 } }))
          .toMatchObject({ matched: false, checks: [{ reason: "type_mismatch" }] });
      }
    }
  });

  it("validates references with the same path limits and requires one comparison operand", () => {
    for (const rule of [
      { field: "payload.id", op: "eq" },
      { field: "payload.id", op: "eq", value: 101, valueField: "payload.author_id" },
      ...["contains", "not_contains", "in", "not_in", "exists"].map((op) => ({ field: "payload.id", op, valueField: "payload.author_id" })),
      ...["", "headers.token", "payload.__proto__.id", "payload.constructor.id", "payload.prototype.id", "payload.a.*.b.*", `payload.${"x".repeat(256)}`]
        .map((valueField) => ({ field: "payload.id", op: "eq", valueField })),
      { field: "payload.__proto__.id", op: "eq", valueField: "payload.id" },
      { field: "payload.id", op: "eq", valueField: 101 }
    ]) expect(webhookFilterSchema.safeParse(rule).success).toBe(false);
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

describe("Label-gated review event presets", () => {
  const preset = (provider: string) => {
    const selected = listWebhookProviders().find((item) => item.id === provider)!.filterPresets
      .find((item) => item.id === "label-code-review");
    expect(selected, `${provider} label review preset`).toBeDefined();
    return webhookFilterSchema.parse(selected!.filter);
  };
  const labels = (titles: readonly string[]) => titles.map((title) => ({ title }));

  it.each([
    ["add review label", [], ["CodeReview"], true],
    ["remove blocking label", ["CodeReview", "Done-Pass"], ["CodeReview"], true],
    ["add unrelated label", ["CodeReview"], ["CodeReview", "other"], false],
    ["remove unrelated label", ["CodeReview", "other"], ["CodeReview"], false],
    ["remove review label", ["CodeReview"], [], false],
    ["add blocking label", ["CodeReview"], ["CodeReview", "Done-Pass"], false],
    ["still blocked", ["Done-Pass"], ["Done-Pass", "CodeReview"], false],
    ["still missing review label", ["Done-Pass"], [], false],
    ["same labels", ["CodeReview"], ["CodeReview"], false],
    ["case sensitive", [], ["codereview"], false]
  ] as const)("GitLab: %s", (_name, previous, current, matched) => {
    const payload = { object_kind: "merge_request", labels: labels(current),
      object_attributes: { action: "update", state: "opened", work_in_progress: false },
      changes: { labels: { previous: labels(previous), current: labels(current) } } };
    expect(evaluateWebhookFilter(preset("gitlab"), { eventType: "Merge Request Hook", payload }).matched).toBe(matched);
  });

  it.each([
    [{ action: "open" }, {}, true],
    [{ action: "reopen" }, {}, true],
    [{ action: "update", oldrev: "a".repeat(40) }, {}, true],
    [{ action: "update", oldrev: "" }, {}, false],
    [{ action: "update" }, { draft: { previous: true, current: false } }, true],
    [{ action: "update", draft: undefined, work_in_progress: false }, { work_in_progress: { previous: true, current: false } }, true],
    [{ action: "update" }, { description: { previous: "[ ]", current: "[x]" } }, false],
    [{ action: "update" }, { assignees: { previous: [], current: [{ id: 1 }] } }, false],
    [{ action: "approved" }, {}, false],
    [{ action: "update", draft: true }, { labels: { previous: [] } }, false],
    [{ action: "update", state: "closed" }, { labels: { previous: [] } }, false],
    [{ action: "update" }, { labels: { current: labels(["CodeReview"]) } }, false],
    [{ action: "update" }, { labels: { previous: null } }, false],
    [{ action: "update" }, { labels: { previous: [{}] } }, false]
  ])("GitLab preserves event and state boundaries: %j %j", (attributes, changes, matched) => {
    const payload = JSON.parse(JSON.stringify({ object_kind: "merge_request", labels: labels(["CodeReview"]),
      object_attributes: { state: "opened", draft: false, ...attributes }, changes }));
    expect(evaluateWebhookFilter(preset("gitlab"), { eventType: "Merge Request Hook", payload }).matched).toBe(matched);
  });

  it.each([
    ["labeled", "CodeReview", ["CodeReview"], true],
    ["unlabeled", "Done-Pass", ["CodeReview"], true],
    ["labeled", "other", ["CodeReview", "other"], false],
    ["unlabeled", "other", ["CodeReview"], false],
    ["labeled", "Done-Pass", ["CodeReview", "Done-Pass"], false],
    ["unlabeled", "CodeReview", [], false],
    ["labeled", "CodeReview", ["CodeReview", "Done-Pass"], false],
    ["unlabeled", "Done-Pass", [], false],
    ["labeled", undefined, ["CodeReview"], false],
    ["opened", undefined, ["CodeReview"], true],
    ["reopened", undefined, ["CodeReview"], true],
    ["synchronize", undefined, ["CodeReview"], true],
    ["synchronize", undefined, ["CodeReview", "Done-Pass"], false],
    ["ready_for_review", undefined, ["CodeReview"], true],
    ["edited", undefined, ["CodeReview"], false]
  ] as const)("GitHub handles %s %s with %j", (action, name, current, matched) => {
    const payload = { action, label: { name }, pull_request: { state: "open", draft: false, labels: current.map((value) => ({ name: value })) } };
    expect(evaluateWebhookFilter(preset("github"), { eventType: "pull_request", payload }).matched).toBe(matched);
    if (matched) {
      expect(evaluateWebhookFilter(preset("github"), { eventType: "pull_request", payload: {
        ...payload, pull_request: { ...payload.pull_request, draft: true }
      } }).matched).toBe(false);
    }
  });

  it.each(["gitlab", "github"])("%s can add project and author conditions within the DSL limits", (provider) => {
    const filter = preset(provider);
    if (!("all" in filter)) throw new Error("expected all group");
    expect(webhookFilterSchema.safeParse({ all: [...filter.all,
      { field: "payload.project.id", op: "eq", value: 42 },
      { field: "payload.object_attributes.author_id", op: "not_in", value: [900, 901] }
    ] }).success).toBe(true);
  });
});

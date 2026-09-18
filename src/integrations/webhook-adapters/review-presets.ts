import type { WebhookProviderDefinition } from "../integration-types.js";
import type { WebhookFilter } from "../webhook-filter.js";

/** Editable DSL templates; label policy is explicit, never an implicit ingress rule. */
const reviewPresets = (input: {
  conditions: WebhookFilter[];
  events: WebhookFilter[];
  labelsField: string;
  labelEvents: WebhookFilter[];
}): WebhookProviderDefinition["filterPresets"] => [
  {
    id: "code-review", name: { zh: "MR / PR 审核事件", en: "MR / PR review events" },
    filter: { all: [...input.conditions, { any: input.events }] }
  },
  {
    id: "label-code-review", name: { zh: "按标签审核 MR / PR", en: "Label-gated MR / PR reviews" },
    filter: { all: [
      ...input.conditions,
      { field: input.labelsField, op: "contains", value: "CodeReview" },
      { field: input.labelsField, op: "not_contains", value: "Done-Pass" },
      { any: [...input.events, ...input.labelEvents] }
    ] }
  }
];

export const gitlabReviewPresets = reviewPresets({
  conditions: [
    { field: "eventType", op: "eq", value: "Merge Request Hook" },
    { field: "payload.object_kind", op: "eq", value: "merge_request" },
    { field: "payload.object_attributes.state", op: "eq", value: "opened" },
    { any: [
      { field: "payload.object_attributes.draft", op: "eq", value: false },
      { all: [
        { field: "payload.object_attributes.draft", op: "exists", value: false },
        { field: "payload.object_attributes.work_in_progress", op: "eq", value: false }
      ] }
    ] }
  ],
  events: [
    { field: "payload.object_attributes.action", op: "in", value: ["open", "reopen"] },
    { all: [
      { field: "payload.object_attributes.action", op: "eq", value: "update" },
      { any: [
        { all: [
          { field: "payload.object_attributes.oldrev", op: "exists", value: true },
          { field: "payload.object_attributes.oldrev", op: "neq", value: "" }
        ] },
        { all: [
          { field: "payload.changes.draft.previous", op: "eq", value: true },
          { field: "payload.changes.draft.current", op: "eq", value: false }
        ] },
        { all: [
          { field: "payload.changes.work_in_progress.previous", op: "eq", value: true },
          { field: "payload.changes.work_in_progress.current", op: "eq", value: false }
        ] }
      ] }
    ] }
  ],
  labelsField: "payload.labels.*.title",
  labelEvents: [
    { all: [
      { field: "payload.object_attributes.action", op: "eq", value: "update" },
      // Current labels must pass the outer gate, while previous labels must have failed it.
      // Missing previous labels fail closed rather than treating every update as a label addition.
      { any: [
        { field: "payload.changes.labels.previous.*.title", op: "not_contains", value: "CodeReview" },
        { field: "payload.changes.labels.previous.*.title", op: "contains", value: "Done-Pass" }
      ] }
    ] }
  ]
});

export const githubReviewPresets = reviewPresets({
  conditions: [
    { field: "eventType", op: "eq", value: "pull_request" },
    { field: "payload.pull_request.state", op: "eq", value: "open" },
    { field: "payload.pull_request.draft", op: "eq", value: false }
  ],
  events: [{ field: "payload.action", op: "in", value: ["opened", "reopened", "synchronize", "ready_for_review"] }],
  labelsField: "payload.pull_request.labels.*.name",
  labelEvents: [
    { all: [
      { field: "payload.action", op: "eq", value: "labeled" },
      { field: "payload.label.name", op: "eq", value: "CodeReview" }
    ] },
    { all: [
      { field: "payload.action", op: "eq", value: "unlabeled" },
      { field: "payload.label.name", op: "eq", value: "Done-Pass" }
    ] }
  ]
});

import { createHmac } from "node:crypto";

import { constantTimeTokenEqual } from "../../auth.js";
import { requiredWebhookHeader, webhookHeader, webhookPayload, type WebhookAdapter } from "./adapter.js";

const signingKey = (secret: string): Buffer | undefined => {
  if (!secret.startsWith("whsec_")) return undefined;
  const encoded = secret.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 && key.toString("base64") === encoded ? key : undefined;
};

export const gitlabWebhookAdapter: WebhookAdapter = {
  definition: {
    id: "gitlab", name: "GitLab", authModes: ["signature", "token"],
    filterFields: [
      {"path": "payload.labels.*.title", "label": {"zh": "MR 标签名称列表", "en": "MR label titles"}},
      {"path": "payload.user.id", "label": {"zh": "事件操作者 ID（不是 MR 作者）", "en": "Event actor ID (not MR author)"}},
      {
        "path": "eventType",
        "label": {
          "zh": "事件类型",
          "en": "Event type"
        }
      },
      {
        "path": "payload.project.id",
        "label": {
          "zh": "项目 ID",
          "en": "Project ID"
        }
      },
      {
        "path": "payload.object_attributes.author_id",
        "label": {
          "zh": "MR 作者 ID",
          "en": "MR author ID"
        }
      },
      {
        "path": "payload.object_attributes.action",
        "label": {
          "zh": "事件动作",
          "en": "Action"
        }
      },
      {
        "path": "payload.object_attributes.state",
        "label": {
          "zh": "MR 状态",
          "en": "MR state"
        }
      },
      {
        "path": "payload.object_attributes.draft",
        "label": {
          "zh": "草稿",
          "en": "Draft"
        }
      },
      {
        "path": "payload.object_attributes.target_branch",
        "label": {
          "zh": "目标分支",
          "en": "Target branch"
        }
      }
    ],
    filterPresets: [
      {
        "id": "code-review",
        "name": {
          "zh": "MR / PR 审核事件",
          "en": "MR / PR review events"
        },
        "filter": {
          "all": [
            {
              "field": "eventType",
              "op": "eq",
              "value": "Merge Request Hook"
            },
            {
              "field": "payload.object_kind",
              "op": "eq",
              "value": "merge_request"
            },
            {
              "field": "payload.object_attributes.state",
              "op": "eq",
              "value": "opened"
            },
            {
              "any": [
                {
                  "field": "payload.object_attributes.draft",
                  "op": "eq",
                  "value": false
                },
                {
                  "all": [
                    {
                      "field": "payload.object_attributes.draft",
                      "op": "exists",
                      "value": false
                    },
                    {
                      "field": "payload.object_attributes.work_in_progress",
                      "op": "eq",
                      "value": false
                    }
                  ]
                }
              ]
            },
            {
              "any": [
                {
                  "field": "payload.object_attributes.action",
                  "op": "in",
                  "value": [
                    "open",
                    "reopen"
                  ]
                },
                {
                  "all": [
                    {
                      "field": "payload.object_attributes.action",
                      "op": "eq",
                      "value": "update"
                    },
                    {
                      "any": [
                        {
                          "all": [
                            {
                              "field": "payload.object_attributes.oldrev",
                              "op": "exists",
                              "value": true
                            },
                            {
                              "field": "payload.object_attributes.oldrev",
                              "op": "neq",
                              "value": ""
                            }
                          ]
                        },
                        {
                          "all": [
                            {
                              "field": "payload.changes.draft.previous",
                              "op": "eq",
                              "value": true
                            },
                            {
                              "field": "payload.changes.draft.current",
                              "op": "eq",
                              "value": false
                            }
                          ]
                        },
                        {
                          "all": [
                            {
                              "field": "payload.changes.work_in_progress.previous",
                              "op": "eq",
                              "value": true
                            },
                            {
                              "field": "payload.changes.work_in_progress.current",
                              "op": "eq",
                              "value": false
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    ],
    secretHint: {
      zh: "签名验证：粘贴 GitLab 生成的 Signing token（whsec_ 开头）。旧版选择 Token 验证，并填写与平台 Secret token 相同的值。",
      en: "Signature: paste the Signing token generated by GitLab (whsec_ prefix). For older versions, choose Token and enter the matching Secret token."
    }
  },
  validateSecret: (secret, mode) => mode === "token" || signingKey(secret) !== undefined,
  authenticate({ headers, body }, secret, mode) {
    if (mode === "token") {
      const token = headers["x-gitlab-token"];
      return typeof token === "string" && constantTimeTokenEqual(secret, token);
    }
    const key = signingKey(secret);
    const id = webhookHeader(headers, "webhook-id");
    const timestamp = webhookHeader(headers, "webhook-timestamp");
    const signatures = webhookHeader(headers, "webhook-signature");
    if (key === undefined || id === undefined || timestamp === undefined || signatures === undefined || !/^\d+$/.test(timestamp)) return false;
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
    const expected = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64")}`;
    return signatures.split(/\s+/).some((signature) => constantTimeTokenEqual(expected, signature));
  },
  normalize(request) {
    return {
      eventType: requiredWebhookHeader(request.headers, "x-gitlab-event"),
      deliveryId: requiredWebhookHeader(request.headers, "webhook-id", "idempotency-key", "x-gitlab-webhook-uuid"),
      payload: webhookPayload(request)
    };
  }
};

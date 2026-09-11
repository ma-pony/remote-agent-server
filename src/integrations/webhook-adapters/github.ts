import { createHmac } from "node:crypto";

import { constantTimeTokenEqual } from "../../auth.js";
import { requiredWebhookHeader, webhookHeader, webhookPayload, type WebhookAdapter } from "./adapter.js";

export const githubWebhookAdapter: WebhookAdapter = {
  definition: {
    id: "github", name: "GitHub", authModes: ["signature"],
    filterFields: [
      {"path": "payload.pull_request.labels.*.name", "label": {"zh": "PR 标签名称列表", "en": "PR label names"}},
      {"path": "payload.sender.id", "label": {"zh": "事件操作者 ID（不是 PR 作者）", "en": "Event actor ID (not PR author)"}},
      {
        "path": "eventType",
        "label": {
          "zh": "事件类型",
          "en": "Event type"
        }
      },
      {
        "path": "payload.repository.id",
        "label": {
          "zh": "仓库 ID",
          "en": "Repository ID"
        }
      },
      {
        "path": "payload.pull_request.user.id",
        "label": {
          "zh": "PR 作者 ID",
          "en": "PR author ID"
        }
      },
      {
        "path": "payload.pull_request.user.login",
        "label": {
          "zh": "PR 作者账号",
          "en": "PR author login"
        }
      },
      {
        "path": "payload.action",
        "label": {
          "zh": "事件动作",
          "en": "Action"
        }
      },
      {
        "path": "payload.pull_request.state",
        "label": {
          "zh": "PR 状态",
          "en": "PR state"
        }
      },
      {
        "path": "payload.pull_request.draft",
        "label": {
          "zh": "草稿",
          "en": "Draft"
        }
      },
      {
        "path": "payload.pull_request.base.ref",
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
              "value": "pull_request"
            },
            {
              "field": "payload.pull_request.state",
              "op": "eq",
              "value": "open"
            },
            {
              "field": "payload.pull_request.draft",
              "op": "eq",
              "value": false
            },
            {
              "field": "payload.action",
              "op": "in",
              "value": [
                "opened",
                "reopened",
                "synchronize",
                "ready_for_review"
              ]
            }
          ]
        }
      }
    ],
    secretHint: {
      zh: "在 GitHub Webhook 的 Secret 栏填写相同值；支持 JSON 和表单格式。",
      en: "Enter the same value in GitHub's webhook Secret field. JSON and form payloads are supported."
    }
  },
  validateSecret: () => true,
  authenticate({ headers, body }, secret) {
    const signature = webhookHeader(headers, "x-hub-signature-256");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return signature !== undefined && /^sha256=[a-f0-9]{64}$/.test(signature) && constantTimeTokenEqual(expected, signature);
  },
  normalize(request) {
    const eventType = requiredWebhookHeader(request.headers, "x-github-event");
    return {
      eventType,
      deliveryId: requiredWebhookHeader(request.headers, "x-github-delivery"),
      payload: webhookPayload(request, true),
      ...(eventType === "ping" ? { ignoreReason: "ping" } : {})
    };
  }
};

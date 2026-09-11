import { createHmac } from "node:crypto";

import { constantTimeTokenEqual } from "../../auth.js";
import { requiredWebhookHeader, webhookHeader, webhookPayload, type WebhookAdapter } from "./adapter.js";

export const githubWebhookAdapter: WebhookAdapter = {
  definition: {
    id: "github", name: "GitHub", authModes: ["signature"],
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

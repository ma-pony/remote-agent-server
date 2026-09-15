import { z } from "zod";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, isNativeImage } from "./attachment-types.js";

const imageSignatureMatches = (type: string, data: Buffer): boolean => {
  if (type === "image/png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6));
  if (type === "image/webp") return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  return true;
};

export const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(220).refine((name) =>
    name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) <= 220),
  mediaType: z.string().max(128).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).transform((value) => value.toLowerCase()),
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
}).strict().superRefine((attachment, context) => {
  // Buffer.from alone accepts malformed and noncanonical base64.
  if (attachment.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return;
  const bytes = Buffer.from(attachment.data, "base64");
  if (bytes.toString("base64") !== attachment.data || bytes.length > MAX_ATTACHMENT_BYTES) {
    context.addIssue({ code: "custom", path: ["data"], message: "Invalid base64 or attachment too large" });
  } else if (isNativeImage(attachment.mediaType)
    && (bytes.length > MAX_IMAGE_BYTES || !imageSignatureMatches(attachment.mediaType, bytes))) {
    context.addIssue({ code: "custom", path: ["data"], message: "Invalid image signature or image too large" });
  }
});

export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS).superRefine((attachments, context) => {
  const total = attachments.reduce((size, item) => size + Buffer.byteLength(item.data, "base64"), 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) context.addIssue({ code: "custom", message: "Attachments exceed 20 MiB" });
});

export const hasMessageContent = (text: string, attachments?: unknown[]): boolean => text.trim() !== "" || (attachments?.length ?? 0) > 0;

/** Larger upload envelopes must not expand the existing text/parameter storage budget. */
export const validateMessageEnvelope = (value: object, context: z.RefinementCtx): void => {
  const { attachments: _attachments, ...message } = value as { attachments?: unknown };
  if (Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Message text and parameters exceed 1 MiB" });
  }
};

import type { FastifyReply } from "fastify";
import type { StoredAttachment } from "./attachment-store.js";

/** Files are always downloaded; authenticated clients can render safe raster previews from blobs. */
export const sendAttachment = (reply: FastifyReply, attachment: StoredAttachment | undefined) => {
  if (attachment === undefined) return reply.code(404).send({ error: { code: "attachment_not_found", message: "Attachment is unavailable" } });
  return reply.header("Cache-Control", "private, no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name).replaceAll("'", "%27")}`)
    .type(attachment.mediaType).send(attachment.bytes);
};

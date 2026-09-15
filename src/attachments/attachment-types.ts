export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Base64 expansion plus room for the existing text and parameter fields.
export const ATTACHMENT_BODY_LIMIT = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 1024 * 1024;
export const NATIVE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const isNativeImage = (mediaType: string): boolean => NATIVE_IMAGE_TYPES.some((type) => type === mediaType);

export type AttachmentInput = { name: string; mediaType: string; data: string };
export type Attachment = { id: number; name: string; mediaType: string; size: number; available: boolean };

/**
 * Zod schemas for the attachment endpoints (T9, specs/007-refund-service,
 * ADR-0016).
 */

import { z } from "zod";
import { ALLOWED_CONTENT_TYPES, MAX_ATTACHMENT_BYTES } from "../lib/storage";
import { AttachmentResponseSchema } from "../requests/requests.schemas";

export const MintAttachmentBodySchema = z.object({
  fileName: z.string().min(1, "fileName is required").max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z
    .number()
    .int("sizeBytes must be an integer")
    .positive("sizeBytes must be > 0")
    .max(
      MAX_ATTACHMENT_BYTES,
      `sizeBytes must be <= ${MAX_ATTACHMENT_BYTES} bytes (10 MiB)`,
    ),
});
export type MintAttachmentBody = z.infer<typeof MintAttachmentBodySchema>;

export const MintAttachmentResponseSchema = z.object({
  attachmentId: z.string(),
  upload: z.object({
    url: z.string(),
    fields: z.record(z.string(), z.string()),
    objectKey: z.string(),
  }),
});

export const AttachmentConfirmResponseSchema = AttachmentResponseSchema.extend(
  {
    uploadStatus: z.literal("stored"),
  },
);

export const SignedUrlResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.string().datetime(),
});

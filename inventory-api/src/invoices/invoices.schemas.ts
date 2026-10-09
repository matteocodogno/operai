/** Schemas for the invoice-file routes (T21, specs/015-hardware-inventory; plan § Invoice files). */

import { z } from "@hono/zod-openapi";
import { EntitySchema } from "../depreciation/rules.schemas";

export const FileIdParamSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * `contentType` and `sizeBytes` are deliberately NOT narrowed to the policy
 * here: a type outside the allowlist is a 415 and a size over the cap a 413
 * (AC-10.6), not the generic 422 a failed schema would give. Only a body that
 * is not even shaped right (no positive integer size) is a 422.
 */
export const MintBodySchema = z.object({
  entity: EntitySchema,
  invoiceRef: z.string().trim().min(1).max(100),
  fileName: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type MintBody = z.infer<typeof MintBodySchema>;

export const MintResponseSchema = z.object({
  id: z.string(),
  upload: z.object({ url: z.string(), fields: z.record(z.string()) }),
});

export const ConfirmResponseSchema = z.object({ id: z.string(), fileName: z.string() });

export const MAX_LINK_ASSETS = 200;
export const LinkBodySchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_LINK_ASSETS),
});
export const LinkResponseSchema = z.object({ linked: z.array(z.string()) });

export const UrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.literal(60),
});

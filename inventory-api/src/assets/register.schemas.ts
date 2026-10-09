/** Request/response schemas for `POST /assets` (T11, specs/015). */

import { z } from "@hono/zod-openapi";
import { EntitySchema, MAX_INT, isoDate } from "../depreciation/rules.schemas";

export const CATEGORIES = [
  "laptop",
  "desktop",
  "phone",
  "tablet",
  "monitor",
  "peripheral",
  "other",
] as const;
export const CategorySchema = z.enum(CATEGORIES);

export const MAX_QUANTITY = 200;

/** Optional free text: trimmed, blank means "not given". */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .transform((v) => (v === "" ? null : v))
    .optional();

export const RegisterBodySchema = z.object({
  entity: EntitySchema,
  category: CategorySchema,
  description: z.string().trim().min(1).max(500),
  // No rule exists before the launch rules' effective date (2000-01-01).
  purchaseDate: isoDate("2000-01-01"),
  totalPriceCents: z.number().int().min(1).max(MAX_INT),
  quantity: z.number().int().min(1).max(MAX_QUANTITY).default(1),
  // Length against `quantity` is checked by the handler: it has its own code.
  serialNumbers: z.array(z.string().trim().min(1).max(200)).max(MAX_QUANTITY).optional(),
  received: z.boolean().default(true),
  supplier: optionalText(200),
  invoiceRef: optionalText(100),
  locationNote: optionalText(500),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown", "system"]),
});

/** Loose on purpose: `AssetViewBase` is built by one serializer (view.ts). */
export const AssetViewSchema = z
  .object({
    id: z.string(),
    entity: EntitySchema,
    currency: z.enum(["CHF", "EUR"]),
    category: CategorySchema,
    description: z.string(),
    serialNumber: z.string().nullable(),
    purchaseDate: z.string(),
    purchasePriceCents: z.number().int(),
    status: z.enum(["ordered", "in_stock", "assigned", "in_repair", "lost", "disposed"]),
    holder: IdentitySchema.nullable(),
    pendingAssignment: z
      .object({ id: z.string(), assignee: IdentitySchema, createdAt: z.string() })
      .nullable(),
    locationNote: z.string().nullable(),
    supplier: z.string().nullable(),
    invoiceRef: z.string().nullable(),
    invoiceFile: z.object({ id: z.string(), fileName: z.string() }).nullable(),
    toVerify: z.boolean(),
    disposal: z
      .object({
        disposedOn: z.string(),
        reason: z.string(),
        salePriceCents: z.number().int().nullable(),
      })
      .nullable(),
  })
  .passthrough();

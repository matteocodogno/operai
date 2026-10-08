/** Request schema for `PATCH /assets/{id}` (T13, specs/015; AC-1.9, AC-10.1). */

import { z } from "@hono/zod-openapi";
import { MAX_INT, isoDate } from "../depreciation/rules.schemas";
import { CategorySchema } from "./register.schemas";

/** Optional text that may be cleared: trimmed, blank or `null` means "none". */
const clearableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v === null ? null : v.trim() === "" ? null : v.trim()))
    .optional();

/**
 * Fields only `asset:manage` may change. `supplier` and `invoiceRef` are the
 * two an accountant may also change (AC-10.1).
 */
export const MANAGER_ONLY_FIELDS = [
  "category",
  "description",
  "serialNumber",
  "locationNote",
  "toVerify",
  "purchaseDate",
  "purchasePriceCents",
] as const;

/** Why `entity`/`currency` get their own message: AC-1.9. */
export const IMMUTABLE_FIELDS = ["entity", "currency"] as const;

export const EditBodySchema = z
  .object({
    category: CategorySchema.optional(),
    description: z.string().trim().min(1).max(500).optional(),
    serialNumber: clearableText(200),
    locationNote: clearableText(500),
    supplier: clearableText(200),
    invoiceRef: clearableText(100),
    toVerify: z.boolean().optional(),
    purchaseDate: isoDate("2000-01-01").optional(),
    purchasePriceCents: z.number().int().min(1).max(MAX_INT).optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type EditBody = z.infer<typeof EditBodySchema>;

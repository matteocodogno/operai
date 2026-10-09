/** Query and response schemas for the asset reads (T12, specs/015). */

import { z } from "@hono/zod-openapi";
import { EntitySchema } from "../depreciation/rules.schemas";
import { AssetViewSchema, CategorySchema } from "./register.schemas";

const STATUSES = ["ordered", "in_stock", "assigned", "in_repair", "lost", "disposed"] as const;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// ─── Cursor: keyset on (purchaseDate desc, id asc) ──────────────────────────

export interface CursorPosition {
  readonly purchaseDate: string;
  readonly id: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|([A-Za-z0-9_-]{1,64})$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.purchaseDate}|${position.id}`, "utf8").toString("base64url");
}

/** `null` for anything this service did not mint. */
export function decodeCursor(value: string): CursorPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const m = CURSOR_RE.exec(Buffer.from(value, "base64url").toString("utf8"));
  return m ? { purchaseDate: m[1]!, id: m[2]! } : null;
}

export const ListQuerySchema = z.object({
  entity: EntitySchema.optional(),
  status: z.enum(STATUSES).optional(),
  category: CategorySchema.optional(),
  holderUserId: z.string().min(1).max(64).optional(),
  toVerify: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  invoiceRef: z.string().min(1).max(100).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z
    .string()
    .max(200)
    .refine((v) => decodeCursor(v) !== null, "is not a cursor issued by this API")
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export const ListResponseSchema = z.object({
  items: z.array(AssetViewSchema),
  nextCursor: z.string().nullable(),
});

export const IdParamSchema = z.object({ id: z.string().min(1).max(64) });

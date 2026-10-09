/** Request schema for `POST /assets/{id}/dispose` (T18, specs/015; AC-7.1, AC-7.3). */

import { z } from "@hono/zod-openapi";
import { MAX_INT, isoDate } from "../depreciation/rules.schemas";

export const DISPOSAL_REASONS = [
  "ceded_to_employee",
  "sold",
  "scrapped",
  "returned_to_vendor",
  "lost",
] as const;
export type DisposalReason = (typeof DISPOSAL_REASONS)[number];

/** Only these two reasons involve a counterparty paying, so only they may carry a price (AC-7.3). */
export const REASONS_WITH_SALE_PRICE: readonly DisposalReason[] = ["sold", "ceded_to_employee"];

export const DisposeBodySchema = z.object({
  disposedOn: isoDate(),
  reason: z.enum(DISPOSAL_REASONS),
  salePriceCents: z.number().int().min(0).max(MAX_INT).optional(),
});
export type DisposeBody = z.infer<typeof DisposeBodySchema>;

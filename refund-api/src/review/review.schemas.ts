/**
 * Zod schemas for the accounting review queue (T11, specs/007-refund-service,
 * AC-5.1/5.2).
 *
 * `GET /requests/:id` (full detail, including for accounting) is the SAME
 * shared route requests.routes.ts already registers (T7) — canReadRequest
 * (requests.service.ts) already evaluates the owner-OR-in-scope-accounting
 * predicate identically for both audiences (ADR-0015), so this module only
 * adds the QUEUE-specific row shape: a lighter-weight summary than the full
 * `RequestDetail` — requesting employee, submission date, and a per-currency
 * subtotal preview (AC-5.1), never the full line list.
 */

import { z } from "zod";
import { OwnerSchema, RefundStatusSchema, SubtotalSchema } from "../requests/requests.schemas";

export const ReviewQueueItemSchema = z.object({
  id: z.string(),
  // `submitted` (awaiting decision) or `approved` (decided, not yet batched) —
  // the queue now mixes both; the UI badge distinguishes them.
  status: RefundStatusSchema,
  owner: OwnerSchema,
  submittedAt: z.string().datetime(),
  subtotals: z.array(SubtotalSchema),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

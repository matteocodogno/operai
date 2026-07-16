/**
 * Zod schemas for accounting decision request bodies (T12,
 * specs/007-refund-service, AC-7.1/7.3).
 */

import { z } from "zod";

// AC-7.1 — "lower, raise, or set to zero independently per line": no upper
// bound tied to requestedAmountCents, just a non-negative integer.
export const ApprovedTotalBodySchema = z.object({
  approvedTotalCents: z
    .number()
    .int("approvedTotalCents must be an integer")
    .nonnegative("approvedTotalCents must be >= 0"),
});
export type ApprovedTotalBody = z.infer<typeof ApprovedTotalBodySchema>;

// AC-7.3 — a non-empty rejection motivation is required BEFORE the rejection
// is accepted; `.trim()` so whitespace-only input is treated as empty.
export const RejectBodySchema = z.object({
  motivation: z.string().trim().min(1, "motivation is required"),
});
export type RejectBody = z.infer<typeof RejectBodySchema>;

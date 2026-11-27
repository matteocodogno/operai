/**
 * Zod schemas for accounting decision request bodies (T12,
 * specs/20260716-refund-service, AC-7.1/7.3).
 */

import { z } from "zod";
import { noNul } from "../lib/inputText";

// AC-7.1 — "lower, raise, or set to zero independently per line": no upper
// bound tied to requestedAmountCents, just a non-negative integer.
export const ApprovedTotalBodySchema = z.object({
  approvedTotalCents: z
    .number()
    .int("approvedTotalCents must be an integer")
    .nonnegative("approvedTotalCents must be >= 0"),
});
export type ApprovedTotalBody = z.infer<typeof ApprovedTotalBodySchema>;

// specs/20260716-refund-service amendment (2026-11-10) — rejecting ONE line needs a reason just
// like rejecting the whole request does: the employee must be told why.
// Capped at 2000 characters so the reason fits the export PDF's detail column.
export const RejectLineBodySchema = z.object({
  reason: noNul(
    z
      .string()
      .trim()
      .min(1, "reason is required")
      .max(2000, "reason must be at most 2000 characters"),
  ),
});
export type RejectLineBody = z.infer<typeof RejectLineBodySchema>;

// AC-7.3 — a non-empty rejection motivation is required BEFORE the rejection
// is accepted; `.trim()` so whitespace-only input is treated as empty.
export const RejectBodySchema = z.object({
  motivation: noNul(z.string().trim().min(1, "motivation is required")),
});
export type RejectBody = z.infer<typeof RejectBodySchema>;

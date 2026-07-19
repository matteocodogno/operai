/**
 * batchSubtotals — `formatBatchSubtotalsPreview`, a compact single-line
 * per-currency join for list rows (T10, specs/008-refund-monthly-processing/
 * tasks.md; design.md Component inventory: "formatBatchSubtotalsPreview
 * (lib) — NEW — Condensed single-line join for Screen B1's rows, mirroring
 * formatSubtotalsPreview's shape but over the one-figure {currency,
 * approvedCents} batch subtotal, not the two-figure Subtotal").
 *
 * Mirrors `./subtotals.ts`'s `formatSubtotalsPreview` exactly, except a
 * `BatchSubtotal` only ever carries `approvedCents` — there is no
 * requested-vs-approved choice to make here, since every request a batch can
 * contain is already `approved`.
 */

import type { BatchSubtotal } from './batchesApi'
import { formatMoney } from './money'

/**
 * Condenses a batch/candidate set's subtotals into a single-line preview,
 * e.g. "9,10 € · 50,00 CHF" — one segment per currency **present** in
 * `subtotals` (never a synthesized zero-value entry for an absent currency).
 * Returns an empty string for an empty candidate/batch set — the caller
 * decides what to render in that case.
 */
export const formatBatchSubtotalsPreview = (subtotals: readonly BatchSubtotal[]): string =>
  subtotals.map((s) => formatMoney(s.approvedCents, s.currency)).join(' · ')

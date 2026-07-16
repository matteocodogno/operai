/**
 * subtotals — the per-currency `Subtotal` shape shared by every screen that
 * renders `RefundRequest.subtotals[]` (T16, specs/007-refund-service/tasks.md;
 * plan.md "## API contracts" Shared shapes: "subtotals … never blended
 * (AC-3.5/6.6)"), plus a compact single-line formatter for list rows (Screen
 * R1's "a short subtotal preview", design.md; Screen A1 reuses the same
 * condensed format per design.md's Component inventory note on
 * `SubtotalsPanel`: "reusing the same subtotal-formatting logic … just
 * condensed to one line instead of full cards").
 *
 * `SubtotalsPanel` (../components/SubtotalsPanel.tsx) renders the full
 * per-entity card grid for Screen R2; this file holds only the shared type
 * and the condensed-preview formatter so a page (R1) never has to import a
 * component module just to format a string.
 */

import type { Entity } from '../components/EntityBadge'
import type { Currency } from './money'
import { formatMoney } from './money'

/** One entity's requested/approved cents for a request — never blended across entities (AC-3.5). */
export type Subtotal = {
  entity: Entity
  currency: Currency
  requestedCents: number
  approvedCents: number | null
}

/**
 * Condenses a request's subtotals into a single-line preview, e.g.
 * "9,10 € · 50,00 CHF" — one segment per entity **present** in `subtotals`
 * (never a synthesized zero-value entry for an entity with no lines, per
 * design.md F3 step 3). Uses `approvedCents` when present and `useApproved`
 * is true (Screen A1/R1 rows for a decided request), else `requestedCents`.
 * Returns an empty string for a request with no lines yet (draft, zero
 * lines) — the caller decides what to render in that case.
 */
export const formatSubtotalsPreview = (subtotals: readonly Subtotal[], useApproved = false): string =>
  subtotals
    .map((s) => {
      const cents = useApproved && s.approvedCents !== null ? s.approvedCents : s.requestedCents
      return formatMoney(cents, s.currency)
    })
    .join(' · ')

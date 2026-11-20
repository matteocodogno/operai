/**
 * SubtotalsPanel — the request's Totals card: one figure group per **currency** present in a request's
 * `subtotals[]`, never a blended total and never a synthesized zero-value
 * card for an absent currency (T16, specs/20260716-refund-service/tasks.md;
 * design.md F3 step 3: "always renders … as independent per-currency
 * cards … there is no code path that sums them into a single figure … never
 * a synthesized zero-value card for a currency with no lines"; Component
 * inventory: "SubtotalsPanel — NEW, small — … content (never-blended
 * per-currency requested/approved) is new").
 *
 * Post-close change (specs/20260716-refund-service): subtotals now group by currency, not
 * entity (see `../lib/subtotals.ts`'s doc comment) — a request can carry
 * more than two cards (e.g. EUR + CHF + USD) since entity no longer bounds
 * the currency set to two. Each card renders a `CurrencyBadge`, not an
 * `EntityBadge` — entity isn't part of a subtotal at all anymore.
 *
 * `showApproved` toggles a second figure per card (design.md F3 step 2:
 * "approved — … the SubtotalsPanel shows both figures per currency"; F6
 * step 3: "requested totals … while still submitted … once decided it shows
 * both"). While `showApproved` is false, only the requested figure renders,
 * even if the wire happens to carry a non-null `approvedCents` (defensive —
 * the caller is expected to pass subtotals appropriate to the status
 * already, this just never surfaces an approved figure before a decision
 * exists).
 *
 * Presentational: all data arrives via props; no fetching, no formatting
 * decisions beyond `formatMoney`/`CurrencyBadge` (design.md Accessibility:
 * "never a bare number a screen reader could misread as unitless").
 */

import type { ReactNode } from 'react'
import { Card } from '@operai/ui'
import { strings } from '../strings'
import { describeApprovedAmount, formatMoney } from '../lib/money'
import type { Subtotal } from '../lib/subtotals'
import CurrencyBadge from './CurrencyBadge'

export type SubtotalsPanelProps = {
  subtotals: readonly Subtotal[]
  /** Show the approved figure alongside requested (only once a decision exists). */
  showApproved?: boolean
  /** A footnote under the figures, inside the card (the monthly-processing note). */
  footnote?: ReactNode
}

/**
 * The approved row: ONE figure when accounting left the amount alone, and the
 * requested/delta breakdown only where it did not.
 *
 * Before a decision exists the card still shows a plain "Requested" row
 * (`showApproved` false) — that is a different question ("what is being asked
 * for") and is not collapsed.
 */
function ApprovedFigure({ subtotal }: { subtotal: Subtotal }) {
  const t = strings.pages.requestDetail.lines
  const amount = describeApprovedAmount(subtotal.requestedCents, subtotal.approvedCents, subtotal.currency)

  return (
    // `<dt>` and every `<dd>` are direct children of this one `<div>` (a valid `<dl>` group): the grid puts the
    // label on the left and stacks the figures on the right, so no wrapper around the `<dd>`s is needed.
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3">
      <dt className="text-soft">{t.approvedLabel}</dt>
      <dd
        className="col-start-2 text-right font-mono tabular-nums text-grn-text"
        data-testid={`subtotals-approved-${subtotal.currency}`}
        data-changed={amount.changed ? 'true' : 'false'}
      >
        {amount.approved}
      </dd>
      {/* Beneath, never appended: this figure is the one a reader checks the
          line column sums to, so it must sit at the same right edge as the
          lines above it. An inline parenthetical would move it. */}
      {amount.changed && (
        <dd
          className="col-start-2 text-right font-mono tabular-nums text-2xs text-soft"
          data-testid={`subtotals-approved-delta-${subtotal.currency}`}
        >
          {t.approvedDeltaNote(amount.requested, amount.delta)}
        </dd>
      )}
    </div>
  )
}

export default function SubtotalsPanel({ subtotals, showApproved = false, footnote }: SubtotalsPanelProps) {
  const t = strings.pages.requestDetail.lines

  if (subtotals.length === 0) return null

  // One `Card` for the totals section (INC-33); each currency is a figure
  // group inside it, side by side, never a nested bordered panel.
  return (
    <Card title={strings.pages.requestDetail.totalsHeading}>
      <div
        data-testid="subtotals-panel"
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
      >
        {subtotals.map((s) => (
          <div key={s.currency} data-testid={`subtotals-panel-card-${s.currency}`} className="flex flex-col gap-2">
            <CurrencyBadge currency={s.currency} />
            <dl className="flex flex-col gap-1 text-sm">
              {!showApproved && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-soft">{t.requestedLabel}</dt>
                  <dd className="font-mono tabular-nums text-text">{formatMoney(s.requestedCents, s.currency)}</dd>
                </div>
              )}
              {showApproved && <ApprovedFigure subtotal={s} />}
            </dl>
          </div>
        ))}
      </div>
      {footnote}
    </Card>
  )
}

/**
 * SubtotalsPanel — one card per legal entity **present** in a request's
 * `subtotals[]`, never a blended total and never a synthesized zero-value
 * card for an absent entity (T16, specs/007-refund-service/tasks.md;
 * design.md F3 step 3: "always renders … as two independent per-currency
 * cards … there is no code path that sums them into a single figure … never
 * a synthesized zero-value card for an entity with no lines"; Component
 * inventory: "SubtotalsPanel — NEW, small — … content (never-blended
 * per-currency requested/approved) is new").
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
 * decisions beyond `formatMoney`/`EntityBadge` (design.md Accessibility:
 * "never a bare number a screen reader could misread as unitless").
 */

import { strings } from '../strings'
import { formatMoney } from '../lib/money'
import type { Subtotal } from '../lib/subtotals'
import EntityBadge from './EntityBadge'

export type SubtotalsPanelProps = {
  subtotals: readonly Subtotal[]
  /** Show the approved figure alongside requested (only once a decision exists). */
  showApproved?: boolean
}

export default function SubtotalsPanel({ subtotals, showApproved = false }: SubtotalsPanelProps) {
  const t = strings.pages.requestDetail.lines

  if (subtotals.length === 0) return null

  return (
    <div
      data-testid="subtotals-panel"
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
    >
      {subtotals.map((s) => (
        <div
          key={s.entity}
          data-testid={`subtotals-panel-card-${s.entity}`}
          className="flex flex-col gap-2 rounded-md border px-3 py-2.5"
          style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
        >
          <EntityBadge entity={s.entity} />
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt style={{ color: 'var(--soft)' }}>{t.requestedLabel}</dt>
              <dd className="font-mono" style={{ color: 'var(--text)' }}>
                {formatMoney(s.requestedCents, s.currency)}
              </dd>
            </div>
            {showApproved && (
              <div className="flex items-center justify-between gap-3">
                <dt style={{ color: 'var(--soft)' }}>{t.approvedLabel}</dt>
                <dd className="font-mono" style={{ color: 'var(--grn)' }}>
                  {formatMoney(s.approvedCents ?? s.requestedCents, s.currency)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      ))}
    </div>
  )
}

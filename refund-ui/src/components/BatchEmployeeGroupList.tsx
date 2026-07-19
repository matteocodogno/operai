/**
 * BatchEmployeeGroupList — mode-driven (`preview`|`detail`) per-employee,
 * per-currency presentation of a batch/candidate set (T10, specs/008-refund-
 * monthly-processing/tasks.md; design.md Component inventory:
 * "BatchEmployeeGroupList — NEW — Mode-driven (preview|detail), the same
 * mode prop convention ExpenseLineRow/AttachmentList already establish …
 * One component, not two, to keep the per-employee-then-per-currency
 * presentation identical between rehearsal and reality").
 *
 *   - `preview` (Screen B2, from `GET /batches/candidates`'s
 *     `CandidateEmployeeGroup[]`): one section per employee — name/email,
 *     request count, per-currency subtotals (`BatchSubtotalsPanel`). No
 *     request rows/links — a dry-run candidate set has nothing persisted yet
 *     to link to (design.md F1 step 3).
 *   - `detail` (Screen B3, from `GET /batches/:id`'s `BatchEmployeeGroup[]`):
 *     the SAME per-employee, per-currency grouping (design.md F2 step 1:
 *     "the SAME per-employee, per-currency grouping as the preview") — the
 *     group-level subtotal is derived client-side by summing each employee's
 *     REAL request rows' own per-currency subtotals (`BatchRequestRow.
 *     subtotals`; the wire's `BatchEmployeeGroup` carries no separate
 *     group-level `subtotals` field of its own) — PLUS the real, persisted
 *     request rows themselves (id, `RequestStatusBadge`, per-currency
 *     subtotal) that link to `/refund/review/$id` (design.md F2 step 1,
 *     AC-2.2).
 *
 * Each employee group is a labelled region (`aria-label` naming the
 * employee, design.md Accessibility: "disambiguate a list of otherwise-
 * identical controls/sections"); in `detail` mode, each request row's link
 * carries a full `aria-label` ("Open `<employee>`'s request, `<status>`,
 * `<amount>`") rather than relying on visually-adjacent badge/amount text
 * alone (same pattern 007's Screen R1/A1 rows already use).
 *
 * Presentational: all data arrives via props; no fetching.
 */

import { Link } from '@tanstack/react-router'
import { ownerDisplay, strings } from '../strings'
import type { BatchEmployeeGroup, BatchSubtotal, CandidateEmployeeGroup } from '../lib/batchesApi'
import type { Currency } from '../lib/money'
import { formatBatchSubtotalsPreview } from '../lib/batchSubtotals'
import BatchSubtotalsPanel from './BatchSubtotalsPanel'
import RequestStatusBadge from './RequestStatusBadge'

export type BatchEmployeeGroupListProps =
  | { mode: 'preview'; groups: readonly CandidateEmployeeGroup[] }
  | { mode: 'detail'; groups: readonly BatchEmployeeGroup[] }

/**
 * Sums a `detail`-mode employee group's real request rows into a
 * per-currency total, so the group heading reads the same "per-employee,
 * per-currency" shape `preview` mode gets for free from
 * `CandidateEmployeeGroup.subtotals` on the wire. Preserves the order
 * currencies are first encountered (deterministic given a fixed row order).
 */
const aggregateRowSubtotals = (rows: readonly { subtotals: readonly BatchSubtotal[] }[]): BatchSubtotal[] => {
  const totals: Partial<Record<Currency, number>> = {}
  const order: Currency[] = []
  for (const row of rows) {
    for (const s of row.subtotals) {
      if (totals[s.currency] === undefined) order.push(s.currency)
      totals[s.currency] = (totals[s.currency] ?? 0) + s.approvedCents
    }
  }
  return order.map((currency) => ({ currency, approvedCents: totals[currency] as number }))
}

export default function BatchEmployeeGroupList(props: BatchEmployeeGroupListProps) {
  const t = strings.components.batchEmployeeGroupList
  const statusLabels = strings.badges.requestStatus

  if (props.groups.length === 0) return null

  return (
    <div data-testid="batch-employee-group-list" className="flex flex-col gap-4">
      {props.mode === 'preview' &&
        props.groups.map((group) => {
          const ownerName = ownerDisplay(group.owner)
          return (
            <section
              key={group.owner.userId}
              aria-label={t.groupAriaLabel(ownerName)}
              data-testid={`batch-employee-group-${group.owner.userId}`}
              className="flex flex-col gap-3 rounded-md border px-4 py-3"
              style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {ownerName}
                </span>
                <span
                  data-testid={`batch-employee-group-${group.owner.userId}-count`}
                  className="text-xs"
                  style={{ color: 'var(--muted)' }}
                >
                  {t.requestCountLabel(group.requestIds.length)}
                </span>
              </div>
              <BatchSubtotalsPanel subtotals={group.subtotals} />
            </section>
          )
        })}

      {props.mode === 'detail' &&
        props.groups.map((group) => {
          const ownerName = ownerDisplay(group.owner)
          const subtotals = aggregateRowSubtotals(group.requests)
          return (
            <section
              key={group.owner.userId}
              aria-label={t.groupAriaLabel(ownerName)}
              data-testid={`batch-employee-group-${group.owner.userId}`}
              className="flex flex-col gap-3 rounded-md border px-4 py-3"
              style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {ownerName}
                </span>
                <span
                  data-testid={`batch-employee-group-${group.owner.userId}-count`}
                  className="text-xs"
                  style={{ color: 'var(--muted)' }}
                >
                  {t.requestCountLabel(group.requests.length)}
                </span>
              </div>
              <BatchSubtotalsPanel subtotals={subtotals} />
              <div className="flex flex-col gap-2" data-testid={`batch-employee-group-${group.owner.userId}-requests`}>
                {group.requests.map((row) => {
                  const amount = formatBatchSubtotalsPreview(row.subtotals)
                  return (
                    <Link
                      key={row.id}
                      to="/review/$id"
                      params={{ id: row.id }}
                      data-testid={`batch-employee-group-${group.owner.userId}-request-${row.id}`}
                      aria-label={t.openRequestLabel(ownerName, statusLabels[row.status], amount)}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded border text-left transition-colors hover:opacity-90"
                      style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)' }}
                    >
                      <RequestStatusBadge status={row.status} />
                      {amount && (
                        <span className="text-sm font-mono" style={{ color: 'var(--text)' }}>
                          {amount}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            </section>
          )
        })}
    </div>
  )
}

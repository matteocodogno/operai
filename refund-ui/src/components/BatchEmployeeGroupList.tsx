/**
 * BatchEmployeeGroupList — mode-driven (`preview`|`detail`) per-employee,
 * per-currency presentation of a batch/candidate set (T10, specs/20260719-refund-
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
 * Each employee group is a `Card` titled with the employee's name (INC-33),
 * so the section is labelled by the name and the request count is its
 * action-slot meta; in `detail` mode the request rows are `ListRows`, and, each request row's link
 * starts with a visually hidden "Open `<employee>`'s request:" before the visible status, amount and
 * receipts, so its accessible name disambiguates the rows AND contains every word a sighted person sees
 * (WCAG 2.5.3 Label in Name; an `aria-label` restating them drifted from the visible text, found by the live e2e).
 *
 * Presentational: all data arrives via props; no fetching.
 */

import { Link } from '@tanstack/react-router'
import { Card, ListRows, listRowClassName, listRowMetaClassName } from '@operai/ui'
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
  const tPage = strings.pages.batchDetail

  if (props.groups.length === 0) return null

  const groupCount = (userId: string, count: number) => (
    <span data-testid={`batch-employee-group-${userId}-count`} className="text-xs text-soft">
      {t.requestCountLabel(count)}
    </span>
  )

  return (
    <div data-testid="batch-employee-group-list" className="flex flex-col gap-4">
      {props.mode === 'preview' &&
        props.groups.map((group) => (
          <Card
            key={group.owner.userId}
            title={ownerDisplay(group.owner)}
            action={groupCount(group.owner.userId, group.requestIds.length)}
            data-testid={`batch-employee-group-${group.owner.userId}`}
          >
            <BatchSubtotalsPanel subtotals={group.subtotals} />
          </Card>
        ))}

      {props.mode === 'detail' &&
        props.groups.map((group) => {
          const ownerName = ownerDisplay(group.owner)
          return (
            <Card
              key={group.owner.userId}
              title={ownerName}
              action={groupCount(group.owner.userId, group.requests.length)}
              data-testid={`batch-employee-group-${group.owner.userId}`}
            >
              <BatchSubtotalsPanel subtotals={aggregateRowSubtotals(group.requests)} />
              <ListRows testId={`batch-employee-group-${group.owner.userId}-requests`}>
                {group.requests.map((row) => {
                  const amount = formatBatchSubtotalsPreview(row.subtotals)
                  // UX-8: the numbers in full, never compressed; none, no line at all (S9).
                  const receipts = (row.receiptNumbers ?? []).join(', ')
                  const summary = (
                    <>
                      <RequestStatusBadge status={row.status} />
                      {amount && <span className="text-sm font-mono">{amount}</span>}
                    </>
                  )
                  return (
                    <Link
                      key={row.id}
                      to="/review/$id"
                      params={{ id: row.id }}
                      data-testid={`batch-employee-group-${group.owner.userId}-request-${row.id}`}
                      className={receipts ? `${listRowClassName} flex-col items-stretch gap-1` : listRowClassName}
                    >
                      <span className="sr-only">{t.openRequestPrefix(ownerName)}</span>
                      {receipts ? (
                        <>
                          <span className="flex items-center justify-between gap-4">{summary}</span>
                          <span
                            className={`${listRowMetaClassName} font-mono break-words`}
                            data-testid={`batch-employee-group-${group.owner.userId}-request-${row.id}-receipts`}
                          >
                            {tPage.receiptNumbers(receipts)}
                          </span>
                        </>
                      ) : (
                        summary
                      )}
                    </Link>
                  )
                })}
              </ListRows>
            </Card>
          )
        })}
    </div>
  )
}

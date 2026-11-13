import { Card, DataTable, Field, FactList, SkeletonRows, VisuallyHidden, formatDuration } from '@operai/ui'
import type { TotalsAnswer } from '../lib/hoursApi.types'
import { strings } from '../strings'
import ErrorBanner from './ErrorBanner'
import { GROUP_CHOICES, totalsRows } from './TotalsCardRows'
import type { GroupChoice, TotalsRow } from './TotalsCardRows'

export type TotalsView =
  /** Asked, not yet answered (or held back until the lists the filters need have arrived). */
  | { status: 'loading' }
  /** A Custom range that cannot be sent: nothing was asked, and the date fields say why. */
  | { status: 'invalid' }
  /** The read failed; `message` is the sentence, in the person's language. */
  | { status: 'error'; message: string }
  | { status: 'loaded'; answer: TotalsAnswer }

export type TotalsCardProps = {
  view: TotalsView
  groupBy: GroupChoice
  onGroupByChange: (group: GroupChoice) => void
  /** Retry after a failed read. */
  onRetry: () => void
}

/** Whole minutes as hours and minutes ("2 h 30", AC-4.9). */
const short = (minutes: number) => formatDuration(minutes * 60_000, { style: 'short' })

/** What the polite live region says: the arrival of the totals, or the wait for them. */
const announcement = (view: TotalsView): string => {
  if (view.status === 'loading') return strings.totals.loading
  if (view.status !== 'loaded') return ''
  const { totalMinutes } = view.answer
  return totalMinutes === 0
    ? strings.totals.announceEmpty
    : strings.totals.announce(formatDuration(totalMinutes * 60_000, { style: 'spoken' }))
}

const columns = (groupBy: GroupChoice) =>
  [
    { id: 'name', header: strings.totals.groupBy[groupBy], rowHeader: true, render: (row: TotalsRow) => row.label },
    { id: 'time', header: strings.totals.columnTime, numeric: true, render: (row: TotalsRow) => short(row.minutes) },
  ] as const

/**
 * TotalsCard — the Totals card of My hours (specs/029-time-tracking T24; design S1 "Totals", AC-4.5): the
 * total and the groups for the chosen "Group by", exactly as `GET /time-entries/totals` answered. Nothing
 * here is summed or sorted in the browser. The Group by select stays mounted in every state, so a keyboard
 * user who changes it keeps their place while the new grouping loads.
 *
 * States: loading (skeleton + a polite "Loading totals…"), loaded (the total, the table, or "Nothing to
 * total." for 0), a failed read (a warning with Retry inside the card: a failed totals call never blocks
 * the rest of the page) and a range that cannot be sent. The total is announced politely when it arrives;
 * focus is never moved.
 */
export default function TotalsCard({ view, groupBy, onGroupByChange, onRetry }: TotalsCardProps) {
  return (
    <Card title={strings.totals.title} data-testid="hours-totals">
      <VisuallyHidden live data-testid="hours-totals-live">
        {announcement(view)}
      </VisuallyHidden>

      <div className="flex flex-wrap items-end justify-between gap-4">
        {view.status === 'loaded' && (
          <FactList
            testId="hours-totals-total"
            items={[{ id: 'total', term: strings.totals.total, value: short(view.answer.totalMinutes) }]}
          />
        )}
        <Field label={strings.totals.groupBy.label} className="ml-auto">
          {(control) => (
            <select
              {...control}
              value={groupBy}
              onChange={(event) => {
                const choice = GROUP_CHOICES.find((candidate) => candidate === event.target.value)
                if (choice !== undefined) onGroupByChange(choice)
              }}
              data-testid="hours-totals-group"
            >
              {GROUP_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {strings.totals.groupBy[choice]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {view.status === 'loading' && <SkeletonRows rows={3} actions={0} testId="hours-totals-skeleton" />}

      {view.status === 'invalid' && (
        <p className="text-sm text-soft" data-testid="hours-totals-invalid">
          {strings.totals.invalidPeriod}
        </p>
      )}

      {view.status === 'error' && (
        <ErrorBanner
          title={strings.totals.error.title}
          message={view.message}
          onRetry={onRetry}
          testId="hours-totals-error"
        />
      )}

      {view.status === 'loaded' &&
        (view.answer.totalMinutes === 0 ? (
          <p className="text-sm text-soft" data-testid="hours-totals-empty">
            {strings.totals.empty}
          </p>
        ) : (
          <DataTable
            caption={strings.totals.caption[groupBy]}
            columns={columns(groupBy)}
            rows={totalsRows(groupBy, view.answer.groups)}
            getRowKey={(row) => row.key}
            testId="hours-totals-table"
          />
        ))}
    </Card>
  )
}

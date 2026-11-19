import { Button, Icon } from '@operai/ui'
import { current, hasNext, hasPrevious, isCurrent, shift } from '../lib/tablePeriod'
import type { TablePeriod } from '../lib/tablePeriod'
import { strings } from '../strings'

export type PeriodNavigatorProps = {
  /** The period shown. */
  period: TablePeriod
  /** Today as hours-api counts it (`todayZurich()`): "This week" returns to the period holding it. */
  today: string
  /** The period asked for: the one before, the one after, or the one holding today. */
  onPeriodChange: (period: TablePeriod) => void
}

/**
 * PeriodNavigator — previous, this and next period, a week or a month (specs/20261116-record-hours-in-place T9, T18, T20,
 * T22; design S7 "Navigator"; AC-5.5, AC-5.28; plan decision 12). It keeps no state and no address: it reports the period
 * asked for and the page changes the address, so the buttons stay mounted and keep focus across a step. The words are the
 * period's own (`strings.table.week.nav`, `strings.table.month.nav`); nothing else differs.
 *
 * Three of the buttons are unavailable where they cannot move: Next on the current period (the future is not browsed,
 * AC-5.28), Previous on the first period hours-api answers (`hasPrevious`), and "This week" / "This month" on the period that
 * is already the current one. Each is `aria-disabled` rather than `disabled`: it stays in the tab order and keeps focus, so the
 * press that reached the current period leaves the keyboard on Next instead of dropping it to the page (R18), and a press on
 * it asks for nothing.
 */
export default function PeriodNavigator({ period, today, onPeriodChange }: PeriodNavigatorProps) {
  const words = strings.table[period.kind].nav
  const showingCurrent = isCurrent(period, today)
  const canGoBack = hasPrevious(period)
  const canGoForward = hasNext(period, today)
  return (
    <div role="group" aria-label={words.label} className="flex items-center gap-2" data-testid="hours-period-nav">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={words.previous}
        aria-disabled={canGoBack ? undefined : 'true'}
        onClick={() => {
          if (canGoBack) onPeriodChange(shift(period, -1))
        }}
        data-testid="hours-period-previous"
      >
        <Icon name="chevron-left" />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        aria-disabled={showingCurrent ? 'true' : undefined}
        onClick={() => {
          if (!showingCurrent) onPeriodChange(current(period.kind, today))
        }}
        data-testid="hours-period-current"
      >
        {words.current}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={words.next}
        aria-disabled={canGoForward ? undefined : 'true'}
        onClick={() => {
          if (canGoForward) onPeriodChange(shift(period, 1))
        }}
        data-testid="hours-period-next"
      >
        <Icon name="chevron-right" />
      </Button>
    </div>
  )
}

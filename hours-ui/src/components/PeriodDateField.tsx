import { useId, useLayoutEffect, useRef } from 'react'
import { DateInput, Field, VisuallyHidden } from '@operai/ui'
import { periodKey, pickBounds, pickedPeriod, referenceDay } from '../lib/tablePeriod'
import type { TablePeriod } from '../lib/tablePeriod'
import { strings } from '../strings'

export type PeriodDateFieldProps = {
  /** The period shown: its kind is the kind the field picks, and its reference day is what the field shows. */
  period: TablePeriod
  /** Today as hours-api counts it (`todayZurich()`): the last day the field offers (AC-5.31). */
  today: string
  /** The period holding the day picked, of the same kind and never the one shown; the page writes the address. */
  onPeriodChange: (period: TablePeriod) => void
}

/** Writes `day` into the input unless it already says so, so a field that is right is never touched. */
const show = (input: HTMLInputElement | null, day: string) => {
  if (input !== null && input.value !== day) input.value = day
}

/**
 * PeriodDateField — the date field of the table view's toolbar (specs/20261116-record-hours-in-place T23; design F7, S7
 * "Toolbar", G16; plan decision 14, R16; AC-5.30, AC-5.31): the date input the filters already use, in a `Field` labelled for
 * what it does ("Show the week of" / "Show the month of"), described for a reader by a hidden "Up to today.". Picking or
 * typing a day shows the week or the month holding it, in the same kind of period, at once, with no Apply button.
 *
 * **What navigates** (`pickedPeriod`): only a complete day within `pickBounds` — today at the latest, the first period
 * hours-api answers for at the earliest — and only when it is another period than the one shown. A date typed digit by digit
 * passes through days of no use (the year 0002, 0020, 0202), and an emptied or half-typed one is `''`: none of them reads
 * anything, and none says anything (no error text: the limit is stated by the greyed days and the description).
 *
 * **The text is the person's while it has focus** (R16). The input is uncontrolled, and nothing writes `value` while it is
 * focused: a controlled value written under a half-typed date would wipe the segments typed so far, and the render a
 * navigation causes is exactly such a write. It shows the period's reference day (`referenceDay`: today in the current
 * period, else the period's first day) at mount, whenever the period changes while the field is not being used (the
 * navigator, the Period switch, a change of address), and again on blur, which also gives back a refused day. So it keeps
 * no state of its own: after picking Wed 14.10 it reads Mon 12.10 in the week and 01.10 in the month once it loses focus
 * (G21). It stays mounted through every read, and so does what has been typed.
 */
export default function PeriodDateField({ period, today, onPeriodChange }: PeriodDateFieldProps) {
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const { min, max } = pickBounds(period.kind, today)
  const reference = referenceDay(period, today)

  // The period changed under a field that is not being used: it shows the new period's day. One being used is left alone.
  useLayoutEffect(() => {
    if (document.activeElement !== input.current) show(input.current, reference)
  }, [reference])

  return (
    <Field label={strings.table[period.kind].pick.label} testId="hours-period-pick">
      {(control) => (
        <>
          <DateInput
            {...control}
            ref={input}
            defaultValue={reference}
            min={min}
            max={max}
            aria-describedby={hintId}
            onChange={(event) => {
              const asked = pickedPeriod(period.kind, event.target.value, today)
              if (asked !== null && periodKey(asked) !== periodKey(period)) {
                onPeriodChange(asked)
                return
              }
              // Nothing to show, and nobody typing: the field says the period it is on, not the day it was given.
              if (document.activeElement !== event.target) show(event.target, reference)
            }}
            onBlur={(event) => show(event.target, reference)}
            data-testid="hours-period-date"
          />
          <VisuallyHidden id={hintId}>{strings.table.pick.hint}</VisuallyHidden>
        </>
      )}
    </Field>
  )
}

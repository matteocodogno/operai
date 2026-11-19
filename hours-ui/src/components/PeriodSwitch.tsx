import { useId } from 'react'
import { RadioGroupField } from '@operai/ui'
import type { TablePeriodKind } from '../lib/tablePeriod'
import { strings } from '../strings'

export type PeriodSwitchProps = {
  /** The kind of period the table view shows. */
  value: TablePeriodKind
  /** The kind asked for; never the kind already shown. The page decides which period that is (`switchTo`). */
  onChange: (kind: TablePeriodKind) => void
}

const KINDS = ['week', 'month'] as const satisfies readonly TablePeriodKind[]

/**
 * PeriodSwitch — Week | Month, the Period of the table view (specs/20261116-record-hours-in-place T22; design S7 "Toolbar",
 * decision 2; AC-5.26, AC-5.27). A `RadioGroupField` of two native radios, the pattern the entry dialog already uses to choose
 * between Project, Deal, Meeting and Other work: choosing applies at once, there is one tab stop, and the arrow keys select
 * the other radio. It keeps no state and no address: it reports the kind asked for and the page changes the address, so the
 * radios stay mounted and keep focus across the change (they live in the card's part that is never replaced).
 */
export default function PeriodSwitch({ value, onChange }: PeriodSwitchProps) {
  const name = useId()
  const t = strings.table.period
  return (
    <RadioGroupField label={t.label} testId="hours-period-switch">
      {KINDS.map((kind) => (
        <label key={kind}>
          <input
            type="radio"
            name={name}
            value={kind}
            checked={value === kind}
            onChange={() => onChange(kind)}
            data-testid={`hours-period-switch-${kind}`}
          />
          {t[kind]}
        </label>
      ))}
    </RadioGroupField>
  )
}

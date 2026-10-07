import DataTable from './DataTable'
import { formatMoney } from '../lib/money'
import type { Currency, Entity, FiscalYearView } from '../lib/types'
import { strings } from '../strings'

/**
 * RollForwardStatement — the five-line roll-forward of a fiscal year (T38,
 * specs/015-hardware-inventory; design.md T6, § Accessibility "Data tables";
 * AC-8.1): opening book value, less disposals, plus purchases, less
 * depreciation, equals closing book value.
 *
 * A two-column table: each line is a `<th scope="row">` carrying the WORD
 * ("Less disposals") as its accessible name, with the sign beside it as an
 * `aria-hidden` glyph — a lone "−" is unreliable for a screen reader, and the
 * words keep meaning when colour or glyphs are missing. Every figure carries its
 * currency (`formatMoney`); nothing is computed here, the closing figure is the
 * server's (AC-8.1), only displayed. Used by the year detail page and, as the
 * "five lines" of the consequence, by `CloseYearDialog`.
 */

export type RollForwardStatementProps = {
  rollForward: FiscalYearView['rollForward']
  currency: Currency
  entity: Entity
  year: number
}

type Line = { key: keyof typeof strings.yearDetail.statement.lines; cents: number }

export default function RollForwardStatement({ rollForward, currency, entity, year }: RollForwardStatementProps) {
  const t = strings.yearDetail.statement
  const lines: Line[] = [
    { key: 'opening', cents: rollForward.openingCents },
    { key: 'disposals', cents: rollForward.disposalsCents },
    { key: 'purchases', cents: rollForward.purchasesCents },
    { key: 'depreciation', cents: rollForward.depreciationCents },
    { key: 'closing', cents: rollForward.closingCents },
  ]

  return (
    <DataTable
      caption={t.caption(strings.common.entity[entity], year, currency)}
      columns={[
        {
          id: 'line',
          header: t.columns.line,
          rowHeader: true,
          render: ({ key }) => {
            const { sign, label } = t.lines[key]
            return (
              <span className={key === 'closing' ? 'font-semibold' : undefined}>
                <span aria-hidden="true" className="inline-block w-4">
                  {sign}
                </span>
                {label}
              </span>
            )
          },
        },
        {
          id: 'amount',
          header: t.columns.amount,
          numeric: true,
          render: ({ key, cents }) => (
            <span className={key === 'closing' ? 'font-semibold' : undefined}>{formatMoney(cents, currency)}</span>
          ),
        },
      ]}
      rows={lines}
      getRowKey={({ key }) => key}
      testId="roll-forward-statement"
    />
  )
}

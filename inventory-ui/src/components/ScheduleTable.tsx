import DataTable from './DataTable'
import type { DataTableColumn } from './DataTable'
import { formatDate } from '../lib/dates'
import { formatMoney } from '../lib/money'
import type { AssetView, Currency, Ledger } from '../lib/types'
import { strings } from '../strings'

/**
 * ScheduleTable — the depreciation schedule of the Ledger block (T34, specs/015-
 * hardware-inventory; design.md § T2 ledger region, § Accessibility "Data
 * tables"; AC-5.8): one row per year with the depreciation, the book value at
 * year end (each with its currency code) and whether the year is closed. A
 * disposed asset's schedule ends with a "Disposed" row carrying the server's
 * book value (zero). Every figure is the server's — this component only formats
 * (the shared schedule-vectors rule: no money is computed in the UI).
 */

export type ScheduleTableProps = {
  ledger: Ledger
  currency: Currency
  /** Present for a disposed asset: adds the final "Disposed" row. */
  disposal: AssetView['disposal']
}

type Row =
  | { kind: 'year'; year: number; depreciationCents: number; closingCents: number; closed: boolean }
  | { kind: 'disposed'; disposedOn: string; closingCents: number }

export default function ScheduleTable({ ledger, currency, disposal }: ScheduleTableProps) {
  const t = strings.ledger.schedule

  const rows: Row[] = ledger.schedule.map((entry) => ({
    kind: 'year',
    year: entry.year,
    depreciationCents: entry.depreciationCents,
    closingCents: entry.closingCents,
    closed: entry.closed,
  }))
  if (disposal !== null)
    rows.push({ kind: 'disposed', disposedOn: disposal.disposedOn, closingCents: ledger.bookValueCents })

  const columns: DataTableColumn<Row>[] = [
    {
      id: 'year',
      header: t.columns.year,
      rowHeader: true,
      render: (row) => (row.kind === 'year' ? String(row.year) : t.disposedRow(formatDate(row.disposedOn))),
    },
    {
      id: 'depreciation',
      header: t.columns.depreciation,
      numeric: true,
      render: (row) => (row.kind === 'year' ? formatMoney(row.depreciationCents, currency) : t.noDepreciation),
    },
    {
      id: 'bookValue',
      header: t.columns.bookValue,
      numeric: true,
      render: (row) => formatMoney(row.closingCents, currency),
    },
    {
      id: 'state',
      header: t.columns.state,
      render: (row) => (row.kind === 'disposed' ? t.disposedState : row.closed ? t.closed : t.open),
    },
  ]

  return (
    <DataTable
      caption={t.caption}
      regionLabel={t.regionLabel}
      columns={columns}
      rows={rows}
      getRowKey={(row) => (row.kind === 'year' ? String(row.year) : 'disposed')}
      testId="schedule-table"
    />
  )
}

import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  formatAmount,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatMonth,
  formatNumber,
  formatRelative,
} from '../lib/format'

/**
 * The suite's formatters: one way to show a date, a time, a month, a duration, an amount and a
 * number. Display only — APIs exchange ISO 8601 dates and integer minor units;
 * never parse what these return. Numeric dates are `dd.mm.yyyy` in both
 * languages; numbers follow the language (Italian: decimal comma, a dot
 * between thousands from five digits up). Each function takes the locale as
 * its last argument; without it, the person's language (`resolveLocale()`).
 */
const meta: Meta = {
  title: 'Foundations/Formatting',
  parameters: { controls: { disable: true } },
}
export default meta

const NOW = new Date(2026, 9, 31, 15, 0)
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const inMinutes = (count: number) => count * 60_000

type Row = { call: string; en: string; it: string; note?: string }

const ROWS: Row[] = [
  {
    call: "formatDate('2026-10-31')",
    en: formatDate('2026-10-31'),
    it: formatDate('2026-10-31'),
    note: 'Same in both languages',
  },
  {
    call: "formatDateTime('2026-10-31T14:05')",
    en: formatDateTime('2026-10-31T14:05'),
    it: formatDateTime('2026-10-31T14:05'),
    note: 'Local time, 24-hour',
  },
  {
    call: "formatDateLong('2026-10-31')",
    en: formatDateLong('2026-10-31', 'en'),
    it: formatDateLong('2026-10-31', 'it'),
  },
  {
    call: 'formatRelative(5 minutes ago)',
    en: formatRelative(ago(5), NOW, 'en'),
    it: formatRelative(ago(5), NOW, 'it'),
  },
  {
    call: 'formatRelative(3 hours ago)',
    en: formatRelative(ago(180), NOW, 'en'),
    it: formatRelative(ago(180), NOW, 'it'),
  },
  {
    call: 'formatRelative(yesterday)',
    en: formatRelative(ago(24 * 60), NOW, 'en'),
    it: formatRelative(ago(24 * 60), NOW, 'it'),
  },
  {
    call: 'formatRelative(10 days ago)',
    en: formatRelative(ago(10 * 24 * 60), NOW, 'en'),
    it: formatRelative(ago(10 * 24 * 60), NOW, 'it'),
    note: 'A week or older: a plain date',
  },
  {
    call: "formatMonth('2026-11')",
    en: formatMonth('2026-11', 'en'),
    it: formatMonth('2026-11', 'it'),
    note: 'A YYYY-MM group key; a malformed key throws',
  },
  {
    call: "formatDuration(150 min, { style: 'short' })",
    en: formatDuration(inMinutes(150), { style: 'short' }, 'en'),
    it: formatDuration(inMinutes(150), { style: 'short' }, 'it'),
    note: 'Hours worked in a list or total; give a screen reader the spoken style',
  },
  {
    call: "formatDuration(120 min, { style: 'short' })",
    en: formatDuration(inMinutes(120), { style: 'short' }, 'en'),
    it: formatDuration(inMinutes(120), { style: 'short' }, 'it'),
  },
  {
    call: "formatDuration(30 min, { style: 'short' })",
    en: formatDuration(inMinutes(30), { style: 'short' }, 'en'),
    it: formatDuration(inMinutes(30), { style: 'short' }, 'it'),
  },
  {
    call: "formatDuration(125 min, { style: 'short' })",
    en: formatDuration(inMinutes(125), { style: 'short' }, 'en'),
    it: formatDuration(inMinutes(125), { style: 'short' }, 'it'),
    note: 'Minutes after hours are padded, so "2 h 05" never reads as 2.5',
  },
  {
    call: "formatDuration(150 min, { style: 'spoken' })",
    en: formatDuration(inMinutes(150), { style: 'spoken' }, 'en'),
    it: formatDuration(inMinutes(150), { style: 'spoken' }, 'it'),
    note: 'For an aria-label or a sentence',
  },
  { call: "formatMoney(1234550, 'EUR')", en: formatMoney(1234550, 'EUR', 'en'), it: formatMoney(1234550, 'EUR', 'it') },
  {
    call: "formatMoney(123450, 'CHF')",
    en: formatMoney(123450, 'CHF', 'en'),
    it: formatMoney(123450, 'CHF', 'it'),
    note: 'Four digits: no group separator in Italian',
  },
  {
    call: "formatMoney(-4550, 'EUR')",
    en: formatMoney(-4550, 'EUR', 'en'),
    it: formatMoney(-4550, 'EUR', 'it'),
    note: 'A real minus sign',
  },
  {
    call: 'formatAmount(1234550)',
    en: formatAmount(1234550, 'en'),
    it: formatAmount(1234550, 'it'),
    note: 'Currency shown beside it',
  },
  { call: 'formatNumber(1234567)', en: formatNumber(1234567, {}, 'en'), it: formatNumber(1234567, {}, 'it') },
  {
    call: "formatNumber(0.3, { style: 'percent' })",
    en: formatNumber(0.3, { style: 'percent' }, 'en'),
    it: formatNumber(0.3, { style: 'percent' }, 'it'),
  },
  {
    call: 'formatNumber(2.5, { maximumFractionDigits: 1 })',
    en: formatNumber(2.5, { maximumFractionDigits: 1 }, 'en'),
    it: formatNumber(2.5, { maximumFractionDigits: 1 }, 'it'),
  },
]

export const Examples: StoryObj = {
  render: () => (
    <div className="flex max-w-5xl flex-col gap-3">
      <p className="text-sm text-soft">
        Relative times are measured from {formatDateTime(NOW)}. Amounts are integer cents.
      </p>
      <div role="region" aria-label="Formatting examples" tabIndex={0} className="table-region">
        <table className="data-table">
          <caption className="visually-hidden">Formatter output in English and Italian</caption>
          <thead>
            <tr>
              <th scope="col">Call</th>
              <th scope="col" className="is-numeric">
                English
              </th>
              <th scope="col" className="is-numeric">
                Italian
              </th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.call}>
                <th scope="row" className="font-mono text-xs">
                  {row.call}
                </th>
                <td className="is-numeric">{row.en}</td>
                <td className="is-numeric">{row.it}</td>
                <td className="text-xs text-soft">{row.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ),
}

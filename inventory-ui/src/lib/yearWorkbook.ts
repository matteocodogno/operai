import ExcelJS from 'exceljs'
import type { FiscalYearView, Identity } from './types'
import { strings } from '../strings'

/**
 * yearWorkbook — the XLSX of one fiscal year (T39, specs/015-hardware-inventory;
 * design.md F12 step 5; AC-8.8, AC-8.9), built in the browser with `exceljs` (the
 * `estimai-ui` precedent). This module statically imports `exceljs`, so it is only
 * ever loaded through a dynamic `import()` from `ExportYearButton` — the heavy
 * dependency stays in a lazy chunk, never in the page's.
 *
 * Layout: a title row; for an OPEN year one provisional row (a closed year has no
 * such row anywhere); a blank row; the header; one row per asset (purchase date,
 * description, serial number, holder, purchase price, depreciation for the year,
 * book value at year end); a blank row; then the five roll-forward lines, label in
 * the description column and amount beside it.
 *
 * Amounts are NUMBERS in the entity currency's major unit, formatted with two
 * decimals (`#,##0.00`), converted from the API's integer cents by `centsToMajor`
 * with integer arithmetic only — never `cents / 100`, whose binary result can sit
 * a hair off the decimal. All copy, sheet header labels included, comes from
 * `strings.yearDetail.export`. `buildYearWorkbook` is pure: the view in, a
 * workbook out; nothing is computed beyond the unit conversion (the figures are
 * the server's).
 */

const AMOUNT_FORMAT = '#,##0.00'
const DATE_FORMAT = 'dd.mm.yyyy'
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Integer minor units -> a major-unit number whose decimal text is exactly the
 * cents (`33239` -> `332.39`). Built from the whole and fractional parts as a
 * decimal string, so the result is the double nearest the written figure — what
 * the same literal would give. A non-integer is a programmer error and throws.
 */
export const centsToMajor = (cents: number): number => {
  if (!Number.isInteger(cents)) throw new RangeError(`centsToMajor: cents must be an integer, got ${cents}`)
  const absolute = Math.abs(cents)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  const major = Number(`${whole}.${fraction}`)
  return cents < 0 ? -major : major
}

const holderLabel = (holder: Identity | null): string => {
  const t = strings.yearDetail.assets
  if (holder === null) return t.noHolder
  if (holder.status === 'system') return t.holderSystem
  if (holder.status === 'deleted') return t.holderDeleted
  return holder.name ?? t.holderUnknown
}

/** A date-only string as a UTC-midnight `Date` (so every timezone writes the same day); anything else stays text. */
const purchaseDateCell = (iso: string): Date | string => {
  const match = DATE_ONLY.exec(iso)
  if (match === null) return iso
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

/** `welld_ch_fiscal-year-2026.xlsx`; an open year adds `_provisional` so the file is never mistaken for the final one. */
export const yearWorkbookFileName = (view: FiscalYearView): string => {
  const provisional = view.status === 'open' ? `_${strings.yearDetail.export.fileProvisionalSuffix}` : ''
  return `${view.entity}_fiscal-year-${view.year}${provisional}.xlsx`
}

export const buildYearWorkbook = (view: FiscalYearView): ExcelJS.Workbook => {
  const t = strings.yearDetail.export
  const currency = view.currency
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(t.sheetName(view.year))

  sheet.getCell('A1').value = t.title(strings.common.entity[view.entity], view.year, currency)
  sheet.getCell('A1').font = { bold: true, size: 14 }
  if (view.status === 'open') {
    sheet.getCell('A2').value = t.provisional
    sheet.getCell('A2').font = { bold: true, color: { argb: 'FFB45309' } }
  }

  const headerRow = sheet.getRow(view.status === 'open' ? 4 : 3)
  headerRow.values = [
    t.columns.purchaseDate,
    t.columns.description,
    t.columns.serialNumber,
    t.columns.holder,
    t.columns.purchasePrice(currency),
    t.columns.depreciation(currency),
    t.columns.bookValue(currency),
  ]
  headerRow.font = { bold: true }

  let rowNumber = headerRow.number
  for (const asset of view.assets) {
    rowNumber += 1
    const row = sheet.getRow(rowNumber)
    row.getCell(1).value = purchaseDateCell(asset.purchaseDate)
    row.getCell(1).numFmt = DATE_FORMAT
    row.getCell(2).value = asset.description
    row.getCell(3).value = asset.serialNumber
    row.getCell(4).value = holderLabel(asset.holder)
    row.getCell(5).value = centsToMajor(asset.purchasePriceCents)
    row.getCell(6).value = centsToMajor(asset.depreciationCents)
    row.getCell(7).value = centsToMajor(asset.closingCents)
    for (const column of [5, 6, 7]) row.getCell(column).numFmt = AMOUNT_FORMAT
  }

  rowNumber += 2
  sheet.getCell(rowNumber, 2).value = t.rollForwardHeading(currency)
  sheet.getCell(rowNumber, 2).font = { bold: true }

  const lines = strings.yearDetail.statement.lines
  const rollForward: [string, number][] = [
    [lines.opening.label, view.rollForward.openingCents],
    [lines.disposals.label, view.rollForward.disposalsCents],
    [lines.purchases.label, view.rollForward.purchasesCents],
    [lines.depreciation.label, view.rollForward.depreciationCents],
    [lines.closing.label, view.rollForward.closingCents],
  ]
  for (const [label, cents] of rollForward) {
    rowNumber += 1
    sheet.getCell(rowNumber, 2).value = label
    const amount = sheet.getCell(rowNumber, 3)
    amount.value = centsToMajor(cents)
    amount.numFmt = AMOUNT_FORMAT
  }
  sheet.getCell(rowNumber, 2).font = { bold: true }
  sheet.getCell(rowNumber, 3).font = { bold: true }

  sheet.columns = [
    { width: 14 },
    { width: 36 },
    { width: 20 },
    { width: 24 },
    { width: 22 },
    { width: 30 },
    { width: 28 },
  ]

  return workbook
}

/**
 * Builder tests for `buildYearWorkbook` (T39, specs/015-hardware-inventory; design.md
 * F12 step 5; refs AC-8.8, AC-8.9). Every assertion reads the produced workbook
 * BACK from its serialised bytes, so what is checked is the file a user opens, not
 * the in-memory object.
 */

import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildYearWorkbook, centsToMajor, yearWorkbookFileName } from './yearWorkbook'
import type { FiscalYearView } from './types'

const ROLL = {
  openingCents: 2168900,
  disposalsCents: 53000,
  purchasesCents: 1829589,
  depreciationCents: 2245831,
  closingCents: 1699658,
}

const asset = (over: Partial<FiscalYearView['assets'][number]> = {}): FiscalYearView['assets'][number] => ({
  assetId: 'a1',
  purchaseDate: '2026-03-02',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  holder: { id: 'u1', name: 'Anna Rossi', status: 'active' },
  purchasePriceCents: 33239,
  openingCents: 0,
  purchaseCents: 33239,
  depreciationCents: 11080,
  disposalCents: 0,
  closingCents: 22159,
  ...over,
})

const view = (over: Partial<FiscalYearView> = {}): FiscalYearView => ({
  entity: 'welld_ch',
  year: 2026,
  currency: 'CHF',
  status: 'open',
  closedAt: null,
  rollForward: ROLL,
  assets: [
    asset(),
    asset({
      assetId: 'a2',
      purchaseDate: '2024-05-10',
      description: 'Dell monitor',
      serialNumber: null,
      holder: null,
      purchasePriceCents: 45000,
      depreciationCents: 15000,
      disposalCents: 5000,
      closingCents: 0,
    }),
  ],
  ...over,
})

/** Serialise and read back: the file as Excel would receive it. */
const roundTrip = async (source: FiscalYearView): Promise<ExcelJS.Worksheet> => {
  const buffer = await buildYearWorkbook(source).xlsx.writeBuffer()
  const read = new ExcelJS.Workbook()
  await read.xlsx.load(buffer as ArrayBuffer)
  const sheet = read.worksheets[0]
  expect(read.worksheets).toHaveLength(1)
  return sheet
}

const rowsOf = (sheet: ExcelJS.Worksheet): ExcelJS.CellValue[][] => {
  const rows: ExcelJS.CellValue[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as ExcelJS.CellValue[]).slice(1)))
  return rows
}

const allText = (sheet: ExcelJS.Worksheet): string[] =>
  rowsOf(sheet)
    .flat()
    .filter((value): value is string => typeof value === 'string')

const HEADER = [
  'Purchase date',
  'Description',
  'Serial number',
  'Holder',
  'Purchase price (CHF)',
  'Depreciation for the year (CHF)',
  'Book value at year end (CHF)',
]

const headerRowOf = (sheet: ExcelJS.Worksheet): ExcelJS.Row => {
  let found: ExcelJS.Row | undefined
  sheet.eachRow((row) => {
    if (found === undefined && row.getCell(1).value === HEADER[0]) found = row
  })
  if (found === undefined) throw new Error('header row not found')
  return found
}

describe('centsToMajor — integer cents to a major-unit number without float drift', () => {
  it.each([
    [33239, 332.39],
    [0, 0],
    [1, 0.01],
    [5, 0.05],
    [10, 0.1],
    [99, 0.99],
    [100, 1],
    [115, 1.15],
    [29, 0.29],
    [123456789, 1234567.89],
    [-500, -5],
    [-1, -0.01],
    [-33239, -332.39],
  ])('%i cents is %d', (cents, expected) => {
    expect(centsToMajor(cents)).toBe(expected)
  })

  it('refuses a non-integer amount instead of rounding it', () => {
    expect(() => centsToMajor(10.5)).toThrow(RangeError)
    expect(() => centsToMajor(Number.NaN)).toThrow(RangeError)
  })
})

describe('buildYearWorkbook — the sheet', () => {
  it('has one sheet named for the year', async () => {
    const sheet = await roundTrip(view())
    expect(sheet.name).toBe('Fiscal year 2026')
  })

  it('titles the sheet with the entity, year and currency', async () => {
    const sheet = await roundTrip(view())
    expect(sheet.getCell('A1').value).toBe('Fiscal year 2026 - WellD CH (CHF)')
  })

  it('has the AC-8.8 header, with the currency in the amount columns', async () => {
    const sheet = await roundTrip(view())
    const header = headerRowOf(sheet)
    expect((header.values as ExcelJS.CellValue[]).slice(1)).toEqual(HEADER)
  })

  it('uses the EUR label for an Italian entity', async () => {
    const sheet = await roundTrip(view({ entity: 'welld_it', currency: 'EUR' }))
    expect(sheet.getCell('A1').value).toBe('Fiscal year 2026 - WellD Italia (EUR)')
    expect(allText(sheet)).toContain('Purchase price (EUR)')
  })

  it('has exactly one row per asset, in the order given, right under the header', async () => {
    const sheet = await roundTrip(view())
    const first = headerRowOf(sheet).number + 1
    const description = (n: number) => sheet.getRow(n).getCell(2).value
    expect(description(first)).toBe('MacBook Pro 14')
    expect(description(first + 1)).toBe('Dell monitor')
    expect(sheet.getRow(first + 2).getCell(2).value).toBeNull()
  })

  it('writes the purchase date as a date, the serial and the holder as text', async () => {
    const sheet = await roundTrip(view())
    const row = sheet.getRow(headerRowOf(sheet).number + 1)
    const date = row.getCell(1).value
    expect(date).toBeInstanceOf(Date)
    expect((date as Date).toISOString()).toBe('2026-03-02T00:00:00.000Z')
    expect(row.getCell(3).value).toBe('SN123')
    expect(row.getCell(4).value).toBe('Anna Rossi')
  })

  it('leaves the serial blank and labels a missing, deleted or system holder', async () => {
    const sheet = await roundTrip(
      view({
        assets: [
          asset({ assetId: 'a1', serialNumber: null, holder: null }),
          asset({ assetId: 'a2', holder: { id: 'u9', name: null, status: 'deleted' } }),
          asset({ assetId: 'a3', holder: { id: 'system:seed', name: null, status: 'system' } }),
          asset({ assetId: 'a4', holder: { id: 'u5', name: null, status: 'unknown' } }),
        ],
      }),
    )
    const first = headerRowOf(sheet).number + 1
    expect(sheet.getRow(first).getCell(3).value).toBeNull()
    expect(sheet.getRow(first).getCell(4).value).toBe('—')
    expect(sheet.getRow(first + 1).getCell(4).value).toBe('Deleted account')
    expect(sheet.getRow(first + 2).getCell(4).value).toBe('System')
    expect(sheet.getRow(first + 3).getCell(4).value).toBe('Unknown')
  })

  it('writes the amounts as numbers in major units, formatted with two decimals', async () => {
    const sheet = await roundTrip(view())
    const row = sheet.getRow(headerRowOf(sheet).number + 1)
    // purchase price 33239 cents, depreciation 11080, book value at year end 22159
    expect(row.getCell(5).value).toBe(332.39)
    expect(row.getCell(6).value).toBe(110.8)
    expect(row.getCell(7).value).toBe(221.59)
    for (const column of [5, 6, 7]) {
      expect(typeof row.getCell(column).value).toBe('number')
      expect(row.getCell(column).numFmt).toBe('#,##0.00')
    }
  })

  it('takes book value at year end from the closing figure, and shows a disposed asset at zero', async () => {
    const sheet = await roundTrip(view())
    const second = sheet.getRow(headerRowOf(sheet).number + 2)
    expect(second.getCell(5).value).toBe(450)
    expect(second.getCell(6).value).toBe(150)
    expect(second.getCell(7).value).toBe(0)
  })

  it('then lists the five roll-forward lines in order, with numeric amounts', async () => {
    const sheet = await roundTrip(view())
    const lines = rowsOf(sheet).filter((row) => typeof row[1] === 'string' && typeof row[2] === 'number')
    expect(lines.map((row) => [row[1], row[2]])).toEqual([
      ['Opening book value', 21689],
      ['Less disposals', 530],
      ['Plus purchases', 18295.89],
      ['Less depreciation', 22458.31],
      ['Closing book value', 16996.58],
    ])
    expect(allText(sheet)).toContain('Roll-forward (CHF)')
  })

  it('puts the roll-forward below the last asset row', async () => {
    const sheet = await roundTrip(view())
    let openingRow = 0
    sheet.eachRow((row) => {
      if (row.getCell(2).value === 'Opening book value') openingRow = row.number
    })
    expect(openingRow).toBeGreaterThan(headerRowOf(sheet).number + 2)
  })

  it('still produces the header and the five lines for a year without assets', async () => {
    const sheet = await roundTrip(view({ assets: [] }))
    expect((headerRowOf(sheet).values as ExcelJS.CellValue[]).slice(1)).toEqual(HEADER)
    expect(rowsOf(sheet).filter((row) => typeof row[1] === 'string' && typeof row[2] === 'number')).toHaveLength(5)
  })

  it('keeps a negative closing figure negative', async () => {
    const sheet = await roundTrip(view({ rollForward: { ...ROLL, closingCents: -500 } }))
    const closing = rowsOf(sheet).find((row) => row[1] === 'Closing book value')
    expect(closing?.[2]).toBe(-5)
  })
})

describe('buildYearWorkbook — the provisional mark (AC-8.9)', () => {
  it('marks an OPEN year as provisional in the sheet', async () => {
    const sheet = await roundTrip(view({ status: 'open' }))
    expect(allText(sheet).filter((text) => /provisional/i.test(text))).toHaveLength(1)
    expect(sheet.getCell('A2').value).toBe('PROVISIONAL: figures change until this year is closed.')
  })

  it('carries no provisional mark anywhere in a CLOSED year', async () => {
    const sheet = await roundTrip(view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' }))
    expect(allText(sheet).filter((text) => /provisional/i.test(text))).toEqual([])
    expect(sheet.name).not.toMatch(/provisional/i)
  })

  it('has the same rows whether open or closed apart from the mark', async () => {
    const open = rowsOf(await roundTrip(view({ status: 'open' })))
    const closed = rowsOf(await roundTrip(view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' })))
    expect(open).toHaveLength(closed.length + 1)
    expect(open.filter((row) => !/provisional/i.test(String(row[0])))).toEqual(closed)
  })
})

describe('yearWorkbookFileName', () => {
  it('names a closed year by entity and year, with no provisional mark', () => {
    expect(yearWorkbookFileName(view({ status: 'closed' }))).toBe('welld_ch_fiscal-year-2026.xlsx')
  })

  it('marks an open year as provisional in the file name', () => {
    expect(yearWorkbookFileName(view({ status: 'open' }))).toBe('welld_ch_fiscal-year-2026_provisional.xlsx')
  })

  it('names the entity of the view', () => {
    expect(yearWorkbookFileName(view({ entity: 'welld_it', year: 2025, status: 'closed' }))).toBe(
      'welld_it_fiscal-year-2025.xlsx',
    )
  })
})

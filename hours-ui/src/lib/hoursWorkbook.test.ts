/**
 * `buildHoursWorkbook` (specs/029-time-tracking T30; plan § Export file; AC-4.6, AC-4.9, AC-4.10; D39, D40).
 * Every assertion reads the workbook BACK from its serialised bytes, so what is checked is the file a person
 * opens, not the in-memory object (the inventory-ui `yearWorkbook.test.ts` way). The expected words are
 * written out here, not read from the catalog the builder reads, so a changed word fails a test.
 */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { en, it as italian } from '../strings'
import { otherWorkOn, projectOn } from '../test-support/fakeApi'
import {
  ACME_DEMO,
  ALL_HANDS,
  ALPHA_DEV,
  EXPORT_DEAL_TOTALS,
  EXPORT_ENTRIES,
  EXPORT_TOTAL_MINUTES,
  KICKOFF_ACME,
  RETRO_UNKNOWN_DEAL,
  SECRET_DEAL,
  SECRET_MEETING_GLOBEX,
  SECRET_PROJECT,
  TRAINING,
  UNNAMED_DEAL,
  UNNAMED_MEETING,
  UNNAMED_PROJECT,
  WEEKLY_HIDDEN_DEAL,
  WEEKLY_UNAVAILABLE_DEAL,
} from '../test-support/fixtures/export'
import type { TimeEntryView } from './hoursApi.types'
import { buildHoursWorkbook, hoursFileName, workbookCopyOf } from './hoursWorkbook'

const copyEn = workbookCopyOf(en)

/** Serialise and read back: the file as the spreadsheet program would receive it. */
const roundTrip = async (items: readonly TimeEntryView[], copy = copyEn): Promise<ExcelJS.Worksheet> => {
  const buffer = await buildHoursWorkbook(items, copy).xlsx.writeBuffer()
  const read = new ExcelJS.Workbook()
  await read.xlsx.load(buffer as ArrayBuffer)
  expect(read.worksheets).toHaveLength(1)
  return read.worksheets[0]!
}

/** The data rows (without the header), each as its nine cells. */
const dataRows = (sheet: ExcelJS.Worksheet): ExcelJS.CellValue[][] => {
  const rows: ExcelJS.CellValue[][] = []
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    if (number > 1) rows.push(Array.from({ length: 9 }, (_, index) => row.getCell(index + 1).value))
  })
  return rows
}

const COLUMNS = {
  day: 1,
  person: 2,
  hours: 3,
  on: 4,
  name: 5,
  countsForDeal: 6,
  categoryOrWorkType: 7,
  activity: 8,
  note: 9,
} as const

describe('the sheet: one header row and one row per entry, in the list order (AC-4.6)', () => {
  it('has the nine columns of plan § Export file, in that order, with the English headers', async () => {
    const sheet = await roundTrip([ALPHA_DEV])
    const header = Array.from({ length: 9 }, (_, index) => sheet.getRow(1).getCell(index + 1).value)
    expect(header).toEqual([
      'Day',
      'Person',
      'Hours',
      'On',
      'Name',
      'Counts for deal',
      'Category or work type',
      'Activity',
      'Note',
    ])
    expect(sheet.columnCount).toBe(9)
  })

  it('writes one row per entry, in the order the entries were given, and nothing after the last', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES)
    expect(sheet.rowCount).toBe(1 + EXPORT_ENTRIES.length)
    expect(dataRows(sheet).map((row) => row[COLUMNS.person - 1])).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Ada Lovelace',
      'Grace Hopper',
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Lovelace',
      'Grace Hopper',
      'Ada Lovelace',
      'Unknown user (deactivated)',
      'Unknown user',
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Lovelace',
    ])
  })

  it('writes a header and nothing else for no entries', async () => {
    const sheet = await roundTrip([])
    expect(sheet.rowCount).toBe(1)
    expect(sheet.getRow(1).getCell(1).value).toBe('Day')
  })

  it('writes the day as a date cell shown dd.mm.yyyy, the same calendar day in every time zone', async () => {
    const sheet = await roundTrip([ALPHA_DEV])
    const cell = sheet.getRow(2).getCell(COLUMNS.day)
    expect(cell.value).toEqual(new Date('2026-11-12T00:00:00.000Z'))
    expect(cell.numFmt).toBe('dd.mm.yyyy')
  })
})

describe('Hours is a number of hours with decimals, so the file can be summed (AC-4.6, AC-4.9, D39)', () => {
  it.each([
    [30, 0.5],
    [60, 1],
    [150, 2.5],
    [240, 4],
    [1440, 24],
  ])('%i minutes is the number %f, formatted 0.0', async (minutes, hours) => {
    const sheet = await roundTrip([{ ...ALPHA_DEV, minutes }])
    const cell = sheet.getRow(2).getCell(COLUMNS.hours)
    expect(cell.value).toBe(hours)
    expect(typeof cell.value).toBe('number')
    expect(cell.numFmt).toBe('0.0')
  })

  it('is never the "2 h 30" text of the screen', async () => {
    const sheet = await roundTrip([{ ...ALPHA_DEV, minutes: 150 }])
    const cells = dataRows(sheet).flat()
    expect(cells).not.toContain('2 h 30')
    expect(cells).toContain(2.5)
  })

  it('writes the sum of the Hours column, to the minute, for the whole fixture', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES)
    const total = dataRows(sheet).reduce((sum, row) => sum + (row[COLUMNS.hours - 1] as number), 0)
    // 2670 minutes, written out by hand in the fixture.
    expect(total * 60).toBe(2670)
  })

  it('refuses an entry whose minutes are not a whole number rather than write a cell nobody can sum', () => {
    expect(() => buildHoursWorkbook([{ ...ALPHA_DEV, minutes: Number.NaN }], copyEn)).toThrow(RangeError)
    expect(() => buildHoursWorkbook([{ ...ALPHA_DEV, minutes: 90.5 }], copyEn)).toThrow(RangeError)
  })
})

describe('what it was on, by name, with what the viewer cannot read written as on screen (AC-4.10)', () => {
  it('names the kind in words, and the project, deal or meeting by its label; other work has no name', async () => {
    const sheet = await roundTrip([ALPHA_DEV, ACME_DEMO, KICKOFF_ACME, TRAINING])
    const rows = dataRows(sheet)
    expect(rows.map((row) => [row[COLUMNS.on - 1], row[COLUMNS.name - 1]])).toEqual([
      ['Project', 'Project Alpha'],
      ['Deal', 'Acme renewal'],
      ['Meeting', 'Kick-off call'],
      ['Other work', null],
    ])
  })

  it('keeps the kind and writes "Not visible to you" for a name the viewer may not read', async () => {
    const sheet = await roundTrip([SECRET_PROJECT])
    const row = dataRows(sheet)[0]!
    expect(row[COLUMNS.on - 1]).toBe('Project')
    expect(row[COLUMNS.name - 1]).toBe('Not visible to you')
  })

  it('writes "Name unavailable" for a name whose owner did not answer, and for a readable one that came without a label', async () => {
    const sheet = await roundTrip([
      UNNAMED_PROJECT,
      UNNAMED_MEETING,
      { ...ALPHA_DEV, on: { ...ALPHA_DEV.on, label: null } as TimeEntryView['on'] },
    ])
    expect(dataRows(sheet).map((row) => row[COLUMNS.name - 1])).toEqual([
      'Name unavailable',
      'Name unavailable',
      'Name unavailable',
    ])
  })
})

describe('Counts for deal: the deal the hours count for, one column for every kind (AC-4.6, D40)', () => {
  const countsFor = async (entry: TimeEntryView) => {
    const sheet = await roundTrip([entry])
    return dataRows(sheet)[0]![COLUMNS.countsForDeal - 1]
  }

  it('holds the deal itself for an entry on a deal', async () => {
    expect(await countsFor(ACME_DEMO)).toBe('Acme renewal')
  })

  it('holds the linked deal for an entry on a meeting, whatever the meeting is called', async () => {
    expect(await countsFor(KICKOFF_ACME)).toBe('Acme renewal')
    // The viewer may not read the meeting but may read its deal: the deal is named, the meeting is not.
    expect(await countsFor(SECRET_MEETING_GLOBEX)).toBe('Globex pilot')
  })

  it('holds a placeholder for a deal the viewer may not read, one whose owner did not answer, or that could not be asked', async () => {
    expect(await countsFor(SECRET_DEAL)).toBe('Not visible to you')
    expect(await countsFor(WEEKLY_HIDDEN_DEAL)).toBe('Not visible to you')
    expect(await countsFor(UNNAMED_DEAL)).toBe('Name unavailable')
    expect(await countsFor(WEEKLY_UNAVAILABLE_DEAL)).toBe('Name unavailable')
    expect(await countsFor(RETRO_UNKNOWN_DEAL)).toBe('Unknown')
  })

  it('is empty for a meeting linked to no deal, for a project and for other work', async () => {
    expect(await countsFor(ALL_HANDS)).toBeNull()
    expect(await countsFor(ALPHA_DEV)).toBeNull()
    expect(await countsFor(SECRET_PROJECT)).toBeNull()
    expect(await countsFor(TRAINING)).toBeNull()
  })

  it('sums, by this column, to the by-deal totals of the same entries: a deal to its group, the placeholders to hidden, unavailable and deal-unknown, empty to none', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES)
    const hoursBy = new Map<string | null, number>()
    for (const row of dataRows(sheet)) {
      const deal = row[COLUMNS.countsForDeal - 1] as string | null
      hoursBy.set(deal, (hoursBy.get(deal) ?? 0) + (row[COLUMNS.hours - 1] as number))
    }
    // The independent fixture answer, group by group (`EXPORT_DEAL_TOTALS` is written out by hand).
    const groupOf = (group: (typeof EXPORT_DEAL_TOTALS.groups)[number]): string | null =>
      group.kind === 'keyed'
        ? group.label
        : group.kind === 'hidden'
          ? 'Not visible to you'
          : group.kind === 'unavailable'
            ? 'Name unavailable'
            : group.kind === 'deal-unknown'
              ? 'Unknown'
              : null
    expect(new Map(EXPORT_DEAL_TOTALS.groups.map((group) => [groupOf(group), group.minutes / 60]))).toEqual(hoursBy)
    expect(EXPORT_DEAL_TOTALS.totalMinutes).toBe(EXPORT_TOTAL_MINUTES)
  })
})

describe('category or work type, activity and note (AC-4.6, AC-3.8, AC-4.10)', () => {
  const cells = async (entry: TimeEntryView) => {
    const row = dataRows(await roundTrip([entry]))[0]!
    return {
      categoryOrWorkType: row[COLUMNS.categoryOrWorkType - 1],
      activity: row[COLUMNS.activity - 1],
      note: row[COLUMNS.note - 1],
    }
  }

  it('holds the work type of an entry on a project or a deal, and the category of other work, as typed', async () => {
    expect((await cells(ALPHA_DEV)).categoryOrWorkType).toBe('Development')
    expect((await cells(ACME_DEMO)).categoryOrWorkType).toBe('Demo')
    expect((await cells(TRAINING)).categoryOrWorkType).toBe('Formazione')
  })

  it('writes a retired work type or category as it is named, with no suffix a sum by it would split on', async () => {
    expect((await cells(UNNAMED_PROJECT)).categoryOrWorkType).toBe('Legacy work')
    expect((await cells({ ...TRAINING, on: otherWorkOn('Old category', 'tc-old', true) })).categoryOrWorkType).toBe(
      'Old category',
    )
  })

  it('is empty for an entry with no work type', async () => {
    expect((await cells(WEEKLY_HIDDEN_DEAL)).categoryOrWorkType).toBeNull()
  })

  it('holds the subject of the activity the entry points at, and a placeholder when it cannot be named', async () => {
    expect((await cells(ALPHA_DEV)).activity).toBe('Write the offer')
    expect((await cells(SECRET_PROJECT)).activity).toBe('Not visible to you')
    expect((await cells(UNNAMED_DEAL)).activity).toBe('Name unavailable')
  })

  it('is empty for an entry that points at no activity, or at one deleted since (activity: null, AC-2.9)', async () => {
    expect((await cells({ ...ACME_DEMO, activity: null })).activity).toBeNull()
  })

  it('holds the full note, line breaks included, and nothing for no note', async () => {
    expect((await cells(ALPHA_DEV)).note).toBe('Line one\nline two')
    expect((await cells(TRAINING)).note).toBe('Corso interno')
    expect((await cells(ACME_DEMO)).note).toBeNull()
    expect((await cells({ ...ACME_DEMO, note: '' })).note).toBeNull()
  })
})

describe('what the file never holds (AC-4.10)', () => {
  /**
   * The entries as a server that got the withholding WRONG would send them: every name, subject and link it was
   * meant to leave out is there, and the deal a meeting counts for carries its id and name. The file must hold
   * none of them, because it decides by `visibility` and never by what is present.
   */
  const leaky = (entry: TimeEntryView): TimeEntryView => {
    const on =
      entry.on.type !== 'none' && entry.on.visibility !== 'visible'
        ? { ...entry.on, label: 'LEAKED NAME', href: '/projects/leaked' }
        : entry.on
    const deal =
      on.type === 'meeting' && on.deal.state === 'linked' && on.deal.visibility !== 'visible'
        ? ({ ...on.deal, id: 'LEAKED-DEAL-ID', label: 'LEAKED DEAL' } as unknown as typeof on.deal)
        : null
    return {
      ...entry,
      on: deal !== null && on.type === 'meeting' ? { ...on, deal } : on,
      activity:
        entry.activity !== null && entry.activity.visibility !== 'visible'
          ? { ...entry.activity, subject: 'LEAKED SUBJECT' }
          : entry.activity,
    }
  }

  const textOf = async (items: readonly TimeEntryView[]): Promise<string[]> =>
    dataRows(await roundTrip(items))
      .flat()
      .filter((value): value is string => typeof value === 'string')

  it('holds no name, subject or deal id the viewer may not read, even when the server sent one', async () => {
    const text = (await textOf(EXPORT_ENTRIES.map(leaky))).join('\n')
    expect(text).not.toContain('LEAKED')
    // ...and the leaky entries really were leaky, so the check above is about the builder.
    expect(JSON.stringify(EXPORT_ENTRIES.map(leaky))).toContain('LEAKED NAME')
    expect(JSON.stringify(EXPORT_ENTRIES.map(leaky))).toContain('LEAKED DEAL')
    expect(JSON.stringify(EXPORT_ENTRIES.map(leaky))).toContain('LEAKED SUBJECT')
  })

  it('holds no id of anything: not an entry, a person, a project, a deal, a meeting, an activity, a category or a work type', async () => {
    const ids = EXPORT_ENTRIES.flatMap((entry) => [
      entry.id,
      entry.person.id,
      ...(entry.on.type === 'none' ? [entry.on.category.id] : [entry.on.id]),
      ...(entry.on.type === 'meeting' && entry.on.deal.state === 'linked' && entry.on.deal.visibility === 'visible'
        ? [entry.on.deal.id]
        : []),
      ...(entry.workType ? [entry.workType.id] : []),
      ...(entry.activity ? [entry.activity.id] : []),
    ])
    expect(new Set(ids).size).toBeGreaterThan(30)
    const text = await textOf(EXPORT_ENTRIES)
    for (const id of ids) expect(text.filter((cell) => cell.includes(id))).toEqual([])
  })

  it('holds no link either: no cell is a hyperlink and none holds a path of the suite', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES)
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Hyperlink)
        if (typeof cell.value === 'string') expect(cell.value).not.toMatch(/^\/(projects|crm|my-meetings)\//)
      }),
    )
  })
})

describe('text is text: a person typed it, and a spreadsheet must not run it (AC-3.8, plan § Security)', () => {
  const FORMULAS = ['=1+1', '+SUM(A1:A9)', '-2+3', '@SUM(1)', '=HYPERLINK("http://evil.example","click")']

  it.each(FORMULAS)('keeps %s in a note, a project name, a category and an activity as a string cell', async (text) => {
    const entry: TimeEntryView = {
      ...ALPHA_DEV,
      note: text,
      on: projectOn('p1', text),
      activity: { id: 'a-x', subject: text, visibility: 'visible' },
      workType: { id: 'wt-x', name: text, retired: false },
    }
    const sheet = await roundTrip([entry])
    const row = sheet.getRow(2)
    for (const column of [COLUMNS.name, COLUMNS.categoryOrWorkType, COLUMNS.activity, COLUMNS.note]) {
      const cell = row.getCell(column)
      expect(cell.type).toBe(ExcelJS.ValueType.String)
      expect(cell.value).toBe(text)
      expect(cell.formula).toBeUndefined()
    }
  })

  it('still builds when a note holds a character the file format cannot carry', async () => {
    const sheet = await roundTrip([{ ...ALPHA_DEV, note: 'before\u0001after\u0008end' }])
    expect(String(sheet.getRow(2).getCell(COLUMNS.note).value)).toContain('before')
  })

  it('writes the longest note the API takes (1000 characters) whole', async () => {
    const note = 'ö'.repeat(1000)
    const sheet = await roundTrip([{ ...ALPHA_DEV, note }])
    expect(sheet.getRow(2).getCell(COLUMNS.note).value).toBe(note)
  })
})

describe('the words are the viewer’s language (AC-5.5)', () => {
  it('writes the Italian headers, kinds and placeholders from the Italian catalog', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES, workbookCopyOf(italian))
    expect(sheet.name).toBe('Ore')
    expect(Array.from({ length: 9 }, (_, index) => sheet.getRow(1).getCell(index + 1).value)).toEqual([
      'Giorno',
      'Persona',
      'Ore',
      'Su',
      'Nome',
      "Conta per l'opportunità",
      'Categoria o tipo di lavoro',
      'Attività',
      'Nota',
    ])
    const rows = dataRows(sheet)
    // Project, then the project the viewer may not read.
    expect([rows[0]![COLUMNS.on - 1], rows[1]![COLUMNS.on - 1], rows[1]![COLUMNS.name - 1]]).toEqual([
      'Progetto',
      'Progetto',
      'Non visibile a te',
    ])
    // A deal whose name could not be loaded, a meeting whose deal could not be asked, a deactivated account.
    expect(rows[6]![COLUMNS.name - 1]).toBe('Nome non disponibile')
    expect(rows[9]![COLUMNS.countsForDeal - 1]).toBe('Non noto')
    expect(rows[11]![COLUMNS.person - 1]).toBe('Utente sconosciuto (disattivato)')
    expect(rows[11]![COLUMNS.on - 1]).toBe('Altro lavoro')
  })

  it('writes the English ones from the English catalog, and the sheet is called Hours', async () => {
    const sheet = await roundTrip(EXPORT_ENTRIES)
    expect(sheet.name).toBe('Hours')
  })
})

describe('the file name (design F5)', () => {
  it('is hours-<from>_<to>.xlsx from the period, in ISO days', () => {
    expect(hoursFileName('2026-11-01', '2026-11-30')).toBe('hours-2026-11-01_2026-11-30.xlsx')
    expect(hoursFileName('2026-11-12', '2026-11-12')).toBe('hours-2026-11-12_2026-11-12.xlsx')
  })

  it('refuses anything that is not a day, because it becomes a file name: no separator, no escape, no person', () => {
    for (const bad of ['', '2026-11', '../../etc/passwd', '2026-11-01/..', 'Ada Lovelace', '2026-11-01\n']) {
      expect(() => hoursFileName(bad, '2026-11-30')).toThrow(TypeError)
      expect(() => hoursFileName('2026-11-01', bad)).toThrow(TypeError)
    }
  })
})

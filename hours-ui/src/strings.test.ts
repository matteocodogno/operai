import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

const STRINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strings')

/**
 * The areas of the screens, one file each under `src/strings/` (tasks.md T22: stubs here, so each
 * later task edits only its own area and no two parallel tasks meet in one file).
 */
const AREAS = [
  'common',
  'myHours',
  'filters',
  'totals',
  'entries',
  'names',
  'activity',
  'entry',
  'everyone',
  'export',
  'settings',
  'table',
  'recordHours',
]

// Every `strings/<namespace>.ts` module, loaded as written: each exports `<namespace> = { en, it }`
// (`export` is a reserved word, so that one exports `exportStrings`).
type Catalogs = { en: Record<string, unknown>; it: Record<string, unknown> }
const modules = import.meta.glob<Record<string, Catalogs | undefined>>('./strings/*.ts', { eager: true })
const namespaces = Object.entries(modules).map(([file, module]) => {
  const name = path.basename(file, '.ts')
  return [name, module[name] ?? module[`${name}Strings`]] as const
})

describe('strings aggregate (AC-5.5)', () => {
  it('has exactly the areas the tasks edit, one file each', () => {
    const files = readdirSync(STRINGS_DIR).map((file) => path.basename(file, '.ts'))
    expect([...files].sort()).toEqual([...AREAS].sort())
  })

  it('aggregates every file under src/strings/ (an area file nobody wired in would be invisible)', () => {
    expect(Object.keys(strings).sort()).toEqual([...AREAS].sort())
    expect(Object.keys(en).sort()).toEqual([...AREAS].sort())
    expect(Object.keys(italian).sort()).toEqual([...AREAS].sort())
  })
})

describe('strings catalogs (AC-5.5)', () => {
  it.each(namespaces)('%s exports both an English and an Italian catalog', (_name, catalogs) => {
    expect(catalogs?.en).toBeTypeOf('object')
    expect(catalogs?.it).toBeTypeOf('object')
  })

  it('the Italian catalog has every English key, with the same shape', () => {
    expect(catalogGaps(en, italian)).toEqual([])
  })

  it.each(namespaces)('%s: every English key has an Italian one (per file)', (_name, catalogs) => {
    expect(catalogGaps(catalogs?.en, catalogs?.it)).toEqual([])
  })

  it('catalogGaps can fail: it names a key the Italian catalog lacks', () => {
    expect(catalogGaps({ a: 'x', b: { c: 'y' } }, { a: 'x', b: {} })).not.toEqual([])
  })

  it('the Italian catalog is a translation, not a copy of the English', () => {
    expect(italian.common.title).toBe('Ore')
    expect(en.common.title).toBe('Hours')
    expect(italian.common.nav.myHours).not.toBe(en.common.nav.myHours)
    expect(italian.common.permissionDenied.heading).not.toBe(en.common.permissionDenied.heading)
  })

  it('names the tool and its two tabs as the design fixes them', () => {
    expect(en.common.nav.myHours).toBe('My hours')
    expect(en.common.nav.everyone).toBe("Everyone's hours")
    expect(italian.common.nav.myHours).toBe('Le mie ore')
    expect(en.myHours.heading).toBe('My hours')
    expect(en.everyone.heading).toBe("Everyone's hours")
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })
})

/**
 * design.md § "Date rules — copy" (plan amendment 4), word for word, in both languages. The screens' own tests read
 * these through the catalog, which cannot tell a wrong sentence from a right one; this is the one place the table's
 * words are written out, so a catalog edit that drifts from the design fails here and nowhere else.
 */
describe('the date rules copy is the design table, word for word (design.md § Date rules — copy)', () => {
  const FLOOR = '01.01.2000'

  it.each([
    ['en', en.entry.errors, 'Choose a valid day.', 'The day cannot be before 01.01.2000.'],
    ['it', italian.entry.errors, 'Scegli un giorno valido.', 'Il giorno non può precedere il 01.01.2000.'],
  ] as const)('S2 Day (%s): not a calendar day, and before the floor', (_language, errors, invalid, tooEarly) => {
    expect(errors.dayInvalid).toBe(invalid)
    expect(errors.dayTooEarly(FLOOR)).toBe(tooEarly)
  })

  it.each([
    ['en', en.entry.errors, 'Choose a valid day.'],
    ['it', italian.entry.errors, 'Scegli un giorno valido.'],
  ] as const)(
    'S2 Day (%s): an empty field is "not a calendar day" in the table, so it says the same words',
    (_language, errors, invalid) => {
      expect(errors.dayRequired).toBe(invalid)
    },
  )

  it.each([
    [
      'en',
      en.filters.rangeErrors,
      'The start date cannot be before 01.01.2000.',
      'The end date cannot be before 01.01.2000.',
    ],
    [
      'it',
      italian.filters.rangeErrors,
      'La data di inizio non può precedere il 01.01.2000.',
      'La data di fine non può precedere il 01.01.2000.',
    ],
  ] as const)('S1 and S4 Custom (%s): From and To each name their own field', (_language, errors, from, to) => {
    expect(errors.fromTooEarly(FLOOR)).toBe(from)
    expect(errors.toTooEarly(FLOOR)).toBe(to)
    expect(errors.fromTooEarly(FLOOR)).not.toBe(errors.toTooEarly(FLOOR))
  })
})

/**
 * design.md § Amendment 2026-11-19, "Copy": the table view's words, written out once in both languages (the screens'
 * own tests read them through the catalog, which cannot tell a wrong sentence from a right one). The week and the month
 * share one shape (`PeriodWords`), so a word the month lacks is a compile error; the second test makes it a runtime one
 * too (AC-4.6).
 */
describe('the table view copy is the design table, word for word (design.md § Copy; AC-4.6)', () => {
  it.each([
    [
      'en',
      en.table,
      {
        views: ['View of your hours', 'Table', 'List'],
        period: ['Period', 'Week', 'Month'],
        week: [
          'Week 16.11.2026 – 22.11.2026',
          'Choose a week',
          'Previous week',
          'This week',
          'Next week',
          'Show the week of',
          'Loading your week…',
          'No hours recorded this week',
          'Entry saved. 12.11.2026 is outside the week you are viewing.',
          'Scroll sideways to see all seven days.',
        ],
        month: [
          'November 2026',
          'Choose a month',
          'Previous month',
          'This month',
          'Next month',
          'Show the month of',
          'Loading your month…',
          'No hours recorded this month',
          'Entry saved. 12.11.2026 is outside the month you are viewing.',
          'Scroll sideways to see every day of the month.',
        ],
      },
    ],
    [
      'it',
      italian.table,
      {
        views: ['Vista delle tue ore', 'Tabella', 'Elenco'],
        period: ['Periodo', 'Settimana', 'Mese'],
        week: [
          'Settimana 16.11.2026 – 22.11.2026',
          'Scegli una settimana',
          'Settimana precedente',
          'Questa settimana',
          'Settimana successiva',
          'Mostra la settimana del',
          'Caricamento della tua settimana…',
          'Nessuna ora registrata in questa settimana',
          'Registrazione salvata. Il 12.11.2026 è fuori dalla settimana che stai guardando.',
          'Scorri di lato per vedere tutti e sette i giorni.',
        ],
        month: [
          'novembre 2026',
          'Scegli un mese',
          'Mese precedente',
          'Questo mese',
          'Mese successivo',
          'Mostra il mese del',
          'Caricamento del tuo mese…',
          'Nessuna ora registrata in questo mese',
          'Registrazione salvata. Il 12.11.2026 è fuori dal mese che stai guardando.',
          'Scorri di lato per vedere tutti i giorni del mese.',
        ],
      },
    ],
  ] as const)('%s', (_language, table, words) => {
    expect([table.view.label, table.view.table, table.view.list]).toEqual(words.views)
    expect([table.period.label, table.period.week, table.period.month]).toEqual(words.period)
    for (const [kind, label] of [
      ['week', '16.11.2026 – 22.11.2026'],
      ['month', words.month[0]],
    ] as const) {
      const period = table[kind]
      expect(
        [
          period.title(label),
          period.nav.label,
          period.nav.previous,
          period.nav.current,
          period.nav.next,
          period.pick.label,
          period.loading,
          period.empty.title,
          period.savedOutside('12.11.2026'),
          period.scrollHint,
        ],
        kind,
      ).toEqual(words[kind])
    }
  })

  it('the week and the month have the same words under the same keys, in English and in Italian', () => {
    for (const catalog of [en.table, italian.table]) {
      expect(Object.keys(catalog.month).sort()).toEqual(Object.keys(catalog.week).sort())
      expect(Object.keys(catalog.month.nav).sort()).toEqual(Object.keys(catalog.week.nav).sort())
    }
  })

  it('the old week-only words are gone: nothing of the table is worded for the week alone outside `table.week`', () => {
    for (const catalog of [en.table, italian.table] as Record<string, unknown>[]) {
      for (const gone of ['title', 'nav', 'loading', 'savedOutside', 'scrollHint', 'emptyFuture']) {
        expect(catalog, gone).not.toHaveProperty(gone)
      }
      expect(catalog['cell']).not.toHaveProperty('record')
    }
  })
})

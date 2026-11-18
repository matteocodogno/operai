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

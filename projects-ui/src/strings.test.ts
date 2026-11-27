import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

const STRINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strings')

// Every `strings/<namespace>.ts` module, loaded as written: each exports `<namespace> = { en, it }`.
type Catalogs = { en: Record<string, unknown>; it: Record<string, unknown> }
const modules = import.meta.glob<Record<string, Catalogs | undefined>>('./strings/*.ts', { eager: true })
const namespaces = Object.entries(modules).map(([file, module]) => {
  const name = path.basename(file, '.ts')
  return [name, module[name]] as const
})

describe('strings aggregate', () => {
  it('aggregates every file under src/strings/ (a namespace file nobody wired in would be invisible)', () => {
    const files = readdirSync(STRINGS_DIR).map((file) => path.basename(file, '.ts'))
    expect(files.length).toBeGreaterThan(0)
    expect(Object.keys(strings).sort()).toEqual([...files].sort())
  })

  it('keeps one namespace file per later task, so a page only ever fills its own strings (T12–T14, T30–T33)', () => {
    expect(Object.keys(strings)).toEqual(
      expect.arrayContaining(['projects', 'project', 'terms', 'purchaseOrder', 'queue']),
    )
    expect(Object.keys(strings)).not.toContain('contracts')
  })

  it('no "contract" copy is left: a project has terms and a purchase order (D38, A32)', () => {
    const copy = (catalog: unknown): string[] => {
      if (typeof catalog === 'string') return [catalog]
      if (typeof catalog === 'function')
        return copy((catalog as (...args: never[]) => unknown)(...([1, 2, 3] as never[])))
      if (catalog !== null && typeof catalog === 'object') return Object.values(catalog).flatMap(copy)
      return []
    }
    for (const [language, catalog] of [
      ['en', en],
      ['it', italian],
    ] as const) {
      expect(
        copy(catalog).filter((text) => /contract|contratt/i.test(text)),
        language,
      ).toEqual([])
    }
  })

  it('names the purchase order and its words as the spec fixes them (A32, T30)', () => {
    expect(en.purchaseOrder.title).toBe('Purchase order')
    expect(italian.purchaseOrder.title).toBe('Ordine d’acquisto')
    expect(en.terms.title).toBe('Terms')
    expect(italian.terms.title).toBe('Termini')
  })
})

describe('strings catalogs (AC-4.7)', () => {
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

  it('the Italian catalog is a translation, not a copy of the English', () => {
    expect(italian.nav.heading).not.toBe(en.nav.heading)
    expect(italian.badges.projectState.on_hold).not.toBe(en.badges.projectState.on_hold)
    expect(italian.common.permissionDenied.heading).not.toBe(en.common.permissionDenied.heading)
  })

  it('the fallback link to My hours (specs/20261116-record-hours-in-place AC-4.5, AC-4.6) exists in both languages and names My hours in its own', () => {
    expect(en.recordHours.fallback).toBe('Record hours in My hours')
    expect(italian.recordHours.fallback).toBe('Registra ore in Le mie ore')
  })

  it('sentence values with a parameter render it in both languages', () => {
    expect(en.common.pagination.status({ page: 2, totalPages: 3, rangeStart: 26, rangeEnd: 50, total: 60 })).toContain(
      '60',
    )
    expect(
      italian.common.pagination.status({ page: 2, totalPages: 3, rangeStart: 26, rangeEnd: 50, total: 60 }),
    ).toContain('60')
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })
})

/** A figure the way the block hands it to a sentence: the integer (for the plural and the article) and its formatted text. */
const count = (n: number, text = String(n)) => ({ n, text })

describe('the words of the consumption signals (specs/20261112-project-hours US-5, AC-3.2; design § Copy)', () => {
  const t = en.project.consumption
  const ti = italian.project.consumption

  it('has the four wordings of the three states, and "Limit reached" is not "Over the limit" (D95)', () => {
    expect([t.state.onTrack, t.state.closeToLimit, t.state.over, t.state.limitReached]).toEqual([
      'On track',
      'Close to the limit',
      'Over the limit',
      'Limit reached',
    ])
    expect([ti.state.onTrack, ti.state.closeToLimit, ti.state.over, ti.state.limitReached]).toEqual([
      'In linea',
      'Vicino al limite',
      'Oltre il limite',
      'Limite raggiunto',
    ])
  })

  it('says "Less than 0.1 man-day" with the figure it is given, in both languages', () => {
    expect(t.excess.lessThanOneTenth('0.1')).toBe('Less than 0.1 man-day')
    expect(ti.excess.lessThanOneTenth('0,1')).toBe('Meno di 0,1 giornate')
  })

  it('has the pace sentences of the three terms, with and without a time elapsed (English)', () => {
    expect(t.pace.hours(count(70, '70%'))).toBe('Used 70% of the hours')
    expect(t.pace.hoursElapsed(count(82, '82%'), count(50, '50%'))).toBe(
      'Used 82% of the hours with 50% of the period elapsed',
    )
    expect(t.pace.maxEffort(count(75, '75%'))).toBe('Used 75% of the max effort')
    expect(t.pace.maxEffortElapsed(count(75, '75%'), count(40, '40%'))).toBe(
      'Used 75% of the max effort with 40% of the time to the deadline elapsed',
    )
    expect(t.pace.plannedManDays(count(31, '31%'))).toBe('Used 31% of the planned man-days')
  })

  it('has the pace sentences of the three terms in Italian, with the article the figure asks for', () => {
    expect(ti.pace.hours(count(70, '70%'))).toBe('Usato il 70% delle ore')
    expect(ti.pace.hoursElapsed(count(82, '82%'), count(50, '50%'))).toBe(
      'Usato l’82% delle ore con il 50% del periodo trascorso',
    )
    expect(ti.pace.maxEffort(count(75, '75%'))).toBe('Usato il 75% dell’impegno massimo')
    expect(ti.pace.maxEffortElapsed(count(75, '75%'), count(40, '40%'))).toBe(
      'Usato il 75% dell’impegno massimo con il 40% del tempo fino alla scadenza trascorso',
    )
    expect(ti.pace.plannedManDays(count(31, '31%'))).toBe('Usato il 31% delle giornate previste')
  })

  // The article follows how the figure is SAID in Italian, so it follows the integer, never the text around it.
  it.each([
    [0, 'lo 0%'],
    [1, 'l’1%'],
    [2, 'il 2%'],
    [8, 'l’8%'],
    [11, 'l’11%'],
    [12, 'il 12%'],
    [18, 'il 18%'],
    [65, 'il 65%'],
    [79, 'il 79%'],
    [80, 'l’80%'],
    [89, 'l’89%'],
    [90, 'il 90%'],
    [99, 'il 99%'],
    [100, 'il 100%'],
    [116, 'il 116%'],
    [180, 'il 180%'],
    [799, 'il 799%'],
    [800, 'l’800%'],
    [899, 'l’899%'],
    [900, 'il 900%'],
    [1000, 'il 1000%'],
    [1234, 'il 1234%'],
    [2000, 'il 2000%'],
    [8000, 'l’8000%'],
    [11000, 'l’11000%'],
  ])('the Italian article before %i is read from the integer: "%s"', (n, shown) => {
    expect(ti.pace.hours(count(n, `${n}%`))).toBe(`Usato ${shown} delle ore`)
  })

  it('does not choose the article from the formatted text (a thousands separator or a language changes the text, not the word)', () => {
    expect(ti.pace.hours(count(1234, '1.234%'))).toBe('Usato il 1.234% delle ore')
    expect(ti.pace.hours(count(8, '8 %'))).toBe('Usato l’8 % delle ore')
  })

  it('has the labels of the bar in both languages', () => {
    expect([t.bar.today, t.bar.estimate]).toEqual(['Today', 'Estimate'])
    expect([ti.bar.today, ti.bar.estimate]).toEqual(['Oggi', 'Stima'])
  })

  it.each([
    ['deadline', 'passed', 'Deadline passed 27 days ago', 'Scadenza superata da 27 giorni'],
    ['deadline', 'near', 'Deadline in 10 days', 'Scadenza tra 10 giorni'],
    ['endDate', 'passed', 'End date passed 27 days ago', 'Data di fine superata da 27 giorni'],
    ['endDate', 'near', 'End date in 27 days', 'Data di fine tra 27 giorni'],
  ] as const)('the %s sentence "%s" takes a number of days', (which, when, english, italianText) => {
    const days = when === 'passed' ? 27 : which === 'deadline' ? 10 : 27
    expect(t.dates[which][when](count(days))).toBe(english)
    expect(ti.dates[which][when](count(days))).toBe(italianText)
  })

  it.each([
    ['deadline', 'passed', 'Deadline passed 1 day ago', 'Scadenza superata da 1 giorno'],
    ['endDate', 'passed', 'End date passed 1 day ago', 'Data di fine superata da 1 giorno'],
    ['deadline', 'near', 'Deadline in 1 day', 'Scadenza tra 1 giorno'],
    ['endDate', 'near', 'End date in 1 day', 'Data di fine tra 1 giorno'],
  ] as const)('chooses the singular for one day: %s %s', (which, when, english, italianText) => {
    expect(t.dates[which][when](count(1))).toBe(english)
    expect(ti.dates[which][when](count(1))).toBe(italianText)
  })

  it('says "today" for a date that is today, in both languages', () => {
    expect([t.dates.deadline.today, t.dates.endDate.today]).toEqual(['Deadline is today', 'End date is today'])
    expect([ti.dates.deadline.today, ti.dates.endDate.today]).toEqual(['La scadenza è oggi', 'La data di fine è oggi'])
  })
})

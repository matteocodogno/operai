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

  it('keeps one namespace file per later task, so a page only ever fills its own strings (T12–T14)', () => {
    expect(Object.keys(strings)).toEqual(expect.arrayContaining(['projects', 'project', 'contracts']))
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

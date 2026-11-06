import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

const STRINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strings')

describe('strings aggregate', () => {
  it('aggregates every file under src/strings/ (a namespace file nobody wired in would be invisible)', () => {
    const namespaces = readdirSync(STRINGS_DIR).map((file) => path.basename(file, '.ts'))
    expect(namespaces.length).toBeGreaterThan(0)
    expect(Object.keys(strings).sort()).toEqual([...namespaces].sort())
  })

  it('has a module for every area the later tasks fill in place (so none has to edit the aggregator)', () => {
    expect(Object.keys(strings)).toEqual(
      expect.arrayContaining([
        'ask',
        'audio',
        'capture',
        'common',
        'consent',
        'editDetails',
        'erase',
        'host',
        'list',
        'meeting',
        'nav',
        'newMeeting',
        'participants',
        'summaries',
        'templates',
        'text',
        'transcript',
        'upload',
      ]),
    )
  })
})

describe('strings catalogs (INC-24, INC-25)', () => {
  it('the Italian catalog has every English key, with the same shape', () => {
    expect(catalogGaps(en, italian)).toEqual([])
  })

  it('the Italian catalog is a translation, not a copy of the English', () => {
    expect(italian.nav.tabs.templates).not.toBe(en.nav.tabs.templates)
    expect(italian.nav.myHeading).not.toBe(en.nav.myHeading)
    expect(italian.common.permissionDenied.heading).not.toBe(en.common.permissionDenied.heading)
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })
})

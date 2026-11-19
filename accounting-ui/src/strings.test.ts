import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

describe('strings (AC-8.4)', () => {
  it('the Italian catalog has every English key, with the same shape', () => {
    expect(catalogGaps(en, italian)).toEqual([])
  })

  it('names the tool as the design fixes it (§ Copy keys)', () => {
    expect(en.appTitle).toBe('Accounting')
    expect(italian.appTitle).toBe('Contabilità')
  })

  it('the Italian catalog is a translation, not a copy of the English', () => {
    expect(italian.nav.loading).not.toBe(en.nav.loading)
    expect(italian.common.permissionDenied.heading).not.toBe(en.common.permissionDenied.heading)
    expect(italian.common.retry).not.toBe(en.common.retry)
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })
})

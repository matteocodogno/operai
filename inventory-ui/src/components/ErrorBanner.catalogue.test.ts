/**
 * The error catalogue's string contract (T25, specs/015-hardware-inventory;
 * design.md § Error and conflict catalogue). Lives under components/ because
 * the catalogue is what ErrorBanner, GuardrailDialog and the field errors
 * present; it must not live in src/strings/, where strings.test.ts treats
 * every file as a namespace.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'
import { INVENTORY_ERROR_CODES } from '../lib/types'

describe('strings.errors', () => {
  it.each(INVENTORY_ERROR_CODES)('has a non-empty message for the API code %s', (code) => {
    const message = (strings.errors as Record<string, unknown>)[code]
    expect(typeof message).toBe('string')
    expect((message as string).trim().length).toBeGreaterThan(0)
  })

  it('has a message for every status-only failure the catalogue names', () => {
    for (const key of ['validation', 'tooLarge', 'unsupportedType', 'tooManyLookups', 'network', 'unknown'] as const) {
      expect(strings.errors[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('every {placeholder} in a message is one the code carries (extras of the plan or the page context)', () => {
    const allowed = new Set(['serialNumber', 'year', 'entity', 'from', 'name', 'date', 'asset', 'n'])
    for (const message of Object.values(strings.errors)) {
      for (const [, name] of message.matchAll(/\{(\w+)\}/g)) {
        expect(allowed.has(name!), `${name} in "${message}"`).toBe(true)
      }
    }
  })
})

describe('fillTemplate', () => {
  it('substitutes every named placeholder, numbers included', () => {
    expect(fillTemplate(strings.errors.fiscal_year_closed, { year: 2025, entity: 'WellD CH' })).toBe(
      '2025 is closed for WellD CH. Choose a date in an open year.',
    )
  })

  it('substitutes a placeholder that appears twice', () => {
    expect(fillTemplate('{n} and {n}', { n: 3 })).toBe('3 and 3')
  })

  it('leaves a placeholder with no value visible rather than printing "undefined"', () => {
    expect(fillTemplate('Close {year} first.', {})).toBe('Close {year} first.')
  })
})

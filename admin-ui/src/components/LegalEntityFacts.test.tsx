/**
 * @vitest-environment jsdom
 *
 * LegalEntityFacts (T36, design S4): values as facts, no input; "Not filled in" (alert) for a required empty
 * value, "Empty" for an optional one; an address one line per row; the IBAN in groups of four.
 */
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import LegalEntityFacts from './LegalEntityFacts'
import { emptyDetails } from '../lib/legalEntityModel'
import type { LegalEntityDetails } from '../lib/legalEntityModel'

afterEach(cleanup)

const filled: LegalEntityDetails = {
  legalName: 'wellD S.r.l.',
  address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: ['Via Esempio 12', '6900 Lugano', 'Italy'] },
  vatNumber: 'IT00000000000',
  iban: 'IT60X0542811101000000123456',
  contacts: { it: 'Tel. +39 02 0000 0000', en: '' },
}

describe('LegalEntityFacts', () => {
  it('shows every value under its name, in three groups, with no control', () => {
    const { container } = render(<LegalEntityFacts details={filled} ibanPrint="IT60 X054 2811 1010 0000 0123 456" missing={[]} />)

    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Company', 'Address', 'Contacts line'])
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual([
      'Legal name',
      'VAT number',
      'IBAN',
      'Address (Italian)',
      'Address (English)',
      'Contacts line (Italian)',
      'Contacts line (English)',
    ])
    expect(screen.getByTestId('admin-legal-fact-legalName').textContent).toBe('wellD S.r.l.')
    expect(screen.getByTestId('admin-legal-fact-iban').textContent).toBe('IT60 X054 2811 1010 0000 0123 456')
    expect(container.querySelectorAll('input, textarea, select, button')).toHaveLength(0)
  })

  it('falls back to the electronic IBAN when no print is given', () => {
    render(<LegalEntityFacts details={filled} missing={[]} />)
    expect(screen.getByTestId('admin-legal-fact-iban').textContent).toBe('IT60X0542811101000000123456')
  })

  it('prints each address line on its own row, in the address\'s language', () => {
    render(<LegalEntityFacts details={filled} missing={[]} />)
    const address = screen.getByTestId('admin-legal-fact-address.en')
    expect(address.getAttribute('lang')).toBe('en')
    expect(within(address).getAllByText(/./).map((line) => line.textContent)).toEqual(['Via Esempio 12', '6900 Lugano', 'Italy'])
    for (const line of Array.from(address.children)) expect(line.className).toContain('block')
  })

  it('says "Not filled in" with an alert glyph for a missing required value and "Empty" for an optional one', () => {
    render(<LegalEntityFacts details={{ ...emptyDetails(), legalName: 'x' }} missing={['vatNumber', 'address.it', 'address.en']} />)

    const vat = screen.getByTestId('admin-legal-fact-vatNumber')
    expect(vat.textContent).toBe('Not filled in')
    expect(vat.querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('admin-legal-fact-address.it').textContent).toBe('Not filled in')
    expect(screen.getByTestId('admin-legal-fact-iban').textContent).toBe('Empty')
    expect(screen.getByTestId('admin-legal-fact-contacts.it').textContent).toBe('Empty')
  })

  it('treats an address of blank lines as empty', () => {
    render(<LegalEntityFacts details={{ ...filled, address: { it: ['  ', ''], en: filled.address.en } }} missing={['address.it']} />)
    expect(screen.getByTestId('admin-legal-fact-address.it').textContent).toBe('Not filled in')
  })

  it('shows a moved value exactly as moved (a fifth address line is not joined or cut)', () => {
    const five = ['1', '2', '3', '4', 'Svizzera']
    render(<LegalEntityFacts details={{ ...filled, address: { it: five, en: filled.address.en } }} missing={[]} />)
    const lines = within(screen.getByTestId('admin-legal-fact-address.it')).getAllByText(/./)
    expect(lines.map((line) => line.textContent)).toEqual(five)
  })

  it.each([
    ['filled', filled, []],
    ['with missing values', emptyDetails(), ['legalName', 'vatNumber', 'address.it', 'address.en'] as const],
  ])('has no axe violation, %s', async (_name, details, missing) => {
    const { container } = render(<LegalEntityFacts details={details} missing={missing} />)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})

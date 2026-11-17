/**
 * @vitest-environment jsdom
 *
 * ProtectedChangeList (T60, design S12): a real list, one item per changing detail, the visible words Old and New, the
 * word None for an empty side, values in full (no truncation), the IBAN in mono, no `lang` on the values.
 */
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import ProtectedChangeList from './ProtectedChangeList'
import type { ProtectedChange } from '../lib/legalEntitiesApi'

afterEach(cleanup)

const LONG = 'Società Fiduciaria Internazionale per le Partecipazioni e i Servizi Finanziari Svizzera Italiana SA'
const CHANGES: ProtectedChange[] = [
  { field: 'legalName', before: 'wellD AG', after: LONG },
  { field: 'vatNumber', before: '', after: 'CHE-123.456.788 MWST' },
  { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: '' },
]

describe('ProtectedChangeList', () => {
  it('renders a labelled list with one item per detail, in the order given', () => {
    render(<ProtectedChangeList changes={CHANGES} />)
    const list = screen.getByRole('list', { name: 'Details that change' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('div')?.textContent)).toEqual(['Legal name', 'VAT number', 'IBAN'])
  })

  it('pairs the terms Old and New with their values, and says None for an empty side, never blank', () => {
    render(<ProtectedChangeList changes={CHANGES} />)
    const [name, vat, iban] = screen.getAllByRole('listitem')
    for (const item of [name, vat, iban]) {
      expect(within(item as HTMLElement).getAllByRole('term').map((el) => el.textContent)).toEqual(['Old', 'New'])
    }
    expect(within(vat as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual(['None', 'CHE-123.456.788 MWST'])
    expect(within(iban as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual(['CH93 0076 2011 6238 5295 7', 'None'])
    for (const definition of screen.getAllByRole('definition')) expect(definition.textContent?.trim()).not.toBe('')
  })

  it('treats a value of spaces only as empty', () => {
    render(<ProtectedChangeList changes={[{ field: 'vatNumber', before: '   ', after: 'x' }]} />)
    expect(screen.getAllByRole('definition')[0]?.textContent).toBe('None')
  })

  it('shows a long value in full and lets it wrap (no truncation, no clipping)', () => {
    render(<ProtectedChangeList changes={CHANGES} />)
    const value = screen.getByText(LONG)
    expect(value.textContent).toBe(LONG)
    expect(value.className).toContain('[overflow-wrap:anywhere]')
    expect(value.className).not.toMatch(/truncate|line-clamp|overflow-hidden|text-ellipsis/)
  })

  it('sets the IBAN and VAT number in the mono font and puts no lang on any value', () => {
    render(<ProtectedChangeList changes={CHANGES} />)
    expect(screen.getByText('CH93 0076 2011 6238 5295 7').className).toContain('font-mono')
    expect(screen.getByText('CHE-123.456.788 MWST').className).toContain('font-mono')
    expect(screen.getByText(LONG).className).not.toContain('font-mono')
    expect(document.querySelector('[lang]')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<ProtectedChangeList changes={CHANGES} />)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(results.violations.map((v) => v.id)).toEqual([])
  })
})

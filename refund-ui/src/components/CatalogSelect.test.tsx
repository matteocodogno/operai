/**
 * @vitest-environment jsdom
 *
 * CatalogSelect (T22, specs/20261118-refund-accounting-export, design UX-4 / component #41): number-first labels, the
 * "None" and placeholder options, an inactive current value as a disabled selected option, and the
 * field wiring passing through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Field } from '@operai/ui'
import CatalogSelect from './CatalogSelect'
import { CATALOG_NONE } from '../lib/catalogLabels'

afterEach(cleanup)

const accounts = [
  { id: 'a1', number: '5901', name: 'Spese viaggi in treno' },
  { id: 'a2', number: '5905', name: 'Spese rimborsi' },
]
const vatCodes = [
  { id: 'v1', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' },
  { id: 'v2', code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1' },
]

const optionTexts = () => screen.getAllByRole('option').map((option) => option.textContent)

describe('CatalogSelect', () => {
  it('lists accounts number first, in the order given', () => {
    render(<CatalogSelect kind="account" options={accounts} value="a1" onChange={vi.fn()} aria-label="Account" />)
    expect(optionTexts()).toEqual(['5901 — Spese viaggi in treno', '5905 — Spese rimborsi'])
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('a1')
  })

  it('lists VAT codes code first, with the rate', () => {
    render(<CatalogSelect kind="vatCode" options={vatCodes} value="v2" onChange={vi.fn()} aria-label="VAT" />)
    expect(optionTexts()).toEqual(['NOVAT — Senza IVA (0%)', 'IMP81 — Imposta piena (8.1%)'])
  })

  it('reports the chosen id', () => {
    const onChange = vi.fn()
    render(<CatalogSelect kind="account" options={accounts} value="a1" onChange={onChange} aria-label="Account" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a2' } })
    expect(onChange).toHaveBeenCalledWith('a2')
  })

  it('offers an explicit None option that reports CATALOG_NONE', () => {
    const onChange = vi.fn()
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        value="a1"
        onChange={onChange}
        noneLabel="None (no default)"
        aria-label="Account"
      />,
    )
    expect(optionTexts()[0]).toBe('None (no default)')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: CATALOG_NONE } })
    expect(onChange).toHaveBeenCalledWith(CATALOG_NONE)
  })

  it('shows the placeholder while nothing is chosen, and it can never be picked again', () => {
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        value=""
        onChange={vi.fn()}
        placeholder="Choose an account"
        aria-label="Account"
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].textContent).toBe('Choose an account')
    expect(select.selectedOptions[0].disabled).toBe(true)
  })

  it('keeps None and the placeholder apart: None is a value, the placeholder is not', () => {
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        value={CATALOG_NONE}
        onChange={vi.fn()}
        noneLabel="None"
        placeholder="Choose…"
        aria-label="Account"
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('None')
    expect(select.selectedOptions[0].disabled).toBe(false)
  })

  it('shows an inactive current value as a disabled, selected option marked inactive', () => {
    const current = { id: 'a9', number: '5999', name: 'Vecchio conto', active: false }
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        current={current}
        value="a9"
        onChange={vi.fn()}
        aria-label="A"
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('a9')
    expect(select.selectedOptions[0].textContent).toBe('5999 — Vecchio conto (inactive)')
    expect(select.selectedOptions[0].disabled).toBe(true)
    // The active options stay choosable.
    expect(optionTexts()).toContain('5901 — Spese viaggi in treno')
  })

  it('adds no extra option for an active current value, nor twice for one already in the options', () => {
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        current={{ ...accounts[0], active: true }}
        value="a1"
        onChange={vi.fn()}
        aria-label="A"
      />,
    )
    expect(optionTexts()).toHaveLength(2)
  })

  it('marks an inactive VAT code the same way', () => {
    const current = { id: 'v9', code: 'OLD', label: 'Vecchio', ratePercent: '7.7', active: false }
    render(
      <CatalogSelect
        kind="vatCode"
        options={vatCodes}
        current={current}
        value="v9"
        onChange={vi.fn()}
        aria-label="V"
      />,
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'OLD — Vecchio (7.7%) (inactive)',
    )
  })

  it('takes the field’s control props and other select attributes', () => {
    render(
      <Field label="Account" error="Choose an account." required>
        {(control) => (
          <CatalogSelect
            {...control}
            kind="account"
            options={accounts}
            value=""
            placeholder="Choose an account"
            onChange={vi.fn()}
            aria-busy
            data-testid="classification-account-l1"
          />
        )}
      </Field>,
    )
    const select = screen.getByLabelText(/Account/)
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect(select.getAttribute('aria-required')).toBe('true')
    expect(select.getAttribute('aria-describedby')).toBeTruthy()
    expect(select.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('classification-account-l1')).toBe(select)
  })

  it('stays focusable and keeps its value while disabled is not set (aria-busy only)', () => {
    render(<CatalogSelect kind="account" options={accounts} value="a1" onChange={vi.fn()} aria-busy aria-label="A" />)
    const select = screen.getByRole('combobox')
    select.focus()
    expect(document.activeElement).toBe(select)
  })
})

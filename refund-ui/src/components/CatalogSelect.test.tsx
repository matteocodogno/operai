/**
 * @vitest-environment jsdom
 *
 * CatalogSelect (T22, specs/20261118-refund-accounting-export, design UX-4 / component #41): number-first labels, the
 * "None" and placeholder options, a deactivated or not-found current value as a disabled selected option, and the
 * field wiring passing through. T35, specs/20261119-accounting: values are numbers and codes, and `current` carries
 * Accounting's state (RS3, RS4).
 */

import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Field } from '@operai/ui'
import CatalogSelect from './CatalogSelect'
import { CATALOG_NONE } from '../lib/catalogLabels'

afterEach(cleanup)

const accounts = [
  { number: '5901', name: 'Spese viaggi in treno' },
  { number: '5905', name: 'Spese rimborsi' },
]
const vatCodes = [
  { code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' },
  { code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1' },
]

const optionTexts = () => screen.getAllByRole('option').map((option) => option.textContent)

describe('CatalogSelect', () => {
  it('lists accounts number first, in the order given', () => {
    render(<CatalogSelect kind="account" options={accounts} value="5901" onChange={vi.fn()} aria-label="Account" />)
    expect(optionTexts()).toEqual(['5901 — Spese viaggi in treno', '5905 — Spese rimborsi'])
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('5901')
  })

  it('lists VAT codes code first, with the rate', () => {
    render(<CatalogSelect kind="vatCode" options={vatCodes} value="IMP81" onChange={vi.fn()} aria-label="VAT" />)
    expect(optionTexts()).toEqual(['NOVAT — Senza IVA (0%)', 'IMP81 — Imposta piena (8.1%)'])
  })

  it('reports the chosen number', () => {
    const onChange = vi.fn()
    render(<CatalogSelect kind="account" options={accounts} value="5901" onChange={onChange} aria-label="Account" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '5905' } })
    expect(onChange).toHaveBeenCalledWith('5905')
  })

  it('offers an explicit None option that reports CATALOG_NONE', () => {
    const onChange = vi.fn()
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        value="5901"
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

  it('shows a deactivated current value as a disabled, selected option marked deactivated', () => {
    const current = { number: '5999', name: 'Vecchio conto', state: 'deactivated' as const }
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        current={current}
        value="5999"
        onChange={vi.fn()}
        aria-label="A"
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('5999')
    expect(select.selectedOptions[0].textContent).toBe('5999 — Vecchio conto (deactivated)')
    expect(select.selectedOptions[0].disabled).toBe(true)
    // The active options stay choosable.
    expect(optionTexts()).toContain('5901 — Spese viaggi in treno')
  })

  it('shows a current value that is no longer in Accounting as a disabled option marked so', () => {
    const current = { number: '5998', name: 'Conto sparito', state: 'not_found' as const }
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        current={current}
        value="5998"
        onChange={vi.fn()}
        aria-label="A"
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('5998 — Conto sparito (not in Accounting)')
    expect(select.selectedOptions[0].disabled).toBe(true)
  })

  it('keeps an unchecked current value (Accounting cannot be read) as an ordinary, enabled option', () => {
    const current = { number: '5997', name: 'Come registrato', state: 'unverified' as const }
    render(
      <CatalogSelect kind="account" options={accounts} current={current} value="5997" onChange={vi.fn()} aria-label="A" />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('5997 — Come registrato')
    expect(select.selectedOptions[0].disabled).toBe(false)
  })

  it('adds no extra option for an active current value, nor twice for one already in the options', () => {
    render(
      <CatalogSelect
        kind="account"
        options={accounts}
        current={{ ...accounts[0], state: 'active' }}
        value="5901"
        onChange={vi.fn()}
        aria-label="A"
      />,
    )
    expect(optionTexts()).toHaveLength(2)
  })

  it('marks a deactivated VAT code the same way, and one with no recorded label by its code and rate', () => {
    const current = { code: 'OLD', label: 'Vecchio', ratePercent: '7.7', state: 'deactivated' as const }
    render(
      <CatalogSelect
        kind="vatCode"
        options={vatCodes}
        current={current}
        value="OLD"
        onChange={vi.fn()}
        aria-label="V"
      />,
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'OLD — Vecchio (7.7%) (deactivated)',
    )
    cleanup()

    render(
      <CatalogSelect
        kind="vatCode"
        options={vatCodes}
        current={{ code: 'OLD', label: null, ratePercent: '7.7', state: 'not_found' }}
        value="OLD"
        onChange={vi.fn()}
        aria-label="V"
      />,
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'OLD (7.7%) (not in Accounting)',
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

  it('hands its select to a ref, so a page can focus it', () => {
    const ref = createRef<HTMLSelectElement>()
    render(<CatalogSelect ref={ref} kind="account" options={accounts} value="5901" onChange={vi.fn()} aria-label="A" />)
    expect(ref.current).toBe(screen.getByRole('combobox'))
  })

  it('stays focusable and keeps its value while disabled is not set (aria-busy only)', () => {
    render(<CatalogSelect kind="account" options={accounts} value="5901" onChange={vi.fn()} aria-busy aria-label="A" />)
    const select = screen.getByRole('combobox')
    select.focus()
    expect(document.activeElement).toBe(select)
  })
})

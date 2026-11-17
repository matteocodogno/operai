/**
 * @vitest-environment jsdom
 *
 * AddressLinesField (T37, Q2=B, design S2 "Address lines"): a fieldset of four line inputs, one per stored line
 * beyond four, Line 1 required, the shared hint on every input, a neutral aria-hidden count, each input's own
 * errors, and the typed line handed up padded to the inputs.
 */
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddressLinesField from './AddressLinesField'
import type { AddressLinesFieldProps } from './AddressLinesField'

afterEach(cleanup)

const show = (over: Partial<AddressLinesFieldProps> = {}) => {
  const onChange = vi.fn()
  const view = render(
    <AddressLinesField
      language="it"
      legend="Address (Italian)"
      lines={['Via 1', 'Lugano']}
      errors={new Map()}
      idFor={(index) => `line-${index}`}
      onChange={onChange}
      testIdPrefix="t"
      {...over}
    />,
  )
  return { onChange, ...view }
}

describe('AddressLinesField', () => {
  it('is a fieldset named by its legend with four labelled inputs, however few lines there are', () => {
    show({ lines: [] })
    const group = screen.getByRole('group', { name: /^Address \(Italian\)/ })
    const names = within(group)
      .getAllByRole('textbox')
      .map((el) => el.id)
    expect(names).toEqual(['line-0', 'line-1', 'line-2', 'line-3'])
    expect(within(group).getByRole('textbox', { name: 'Line 4' })).toBeTruthy()
  })

  it('shows one input per stored line beyond four, never fewer than the lines it was given', () => {
    show({ lines: ['1', '2', '3', '4', '5', '6'] })
    expect(screen.getAllByRole('textbox')).toHaveLength(6)
    expect((screen.getByRole('textbox', { name: 'Line 6' }) as HTMLInputElement).value).toBe('6')
  })

  it('requires Line 1 only, and describes every input by the one hint', () => {
    show()
    const inputs = screen.getAllByRole('textbox')
    expect(inputs.map((el) => el.getAttribute('aria-required'))).toEqual(['true', null, null, null])
    const hint = screen.getByText(/^Up to 4 lines of 120 characters/)
    for (const el of inputs) expect(el.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id)
  })

  it('counts each line aria-hidden, trimmed and in code points', () => {
    show({ lines: ['  Via 1  ', '😀😀'] })
    const counts = [...document.querySelectorAll('[aria-hidden="true"].tabular-nums')].map((el) => el.textContent)
    expect(counts).toEqual(['5 / 120', '2 / 120', '0 / 120', '0 / 120'])
  })

  it('marks an input with its errors, each as a sentence under it, and no other', () => {
    show({
      errors: new Map([
        [1, ['Too long: at most 120 characters, you have 143.', 'Use one line: remove the line break.']],
      ]),
    })
    const line2 = screen.getByRole('textbox', { name: 'Line 2' })
    expect(line2.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(line2.getAttribute('aria-describedby')?.split(' ')[0] ?? '')
    expect(error?.textContent).toBe(
      'Too long: at most 120 characters, you have 143.Use one line: remove the line break.',
    )
    expect(screen.getByRole('textbox', { name: 'Line 1' }).getAttribute('aria-invalid')).toBeNull()
  })

  it('hands up every line padded to the inputs, with the typed one replaced and its position', async () => {
    const { onChange } = show()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Line 4' }), 'x')
    expect(onChange).toHaveBeenCalledWith(['Via 1', 'Lugano', '', 'x'], 3)
  })

  it('puts the language on the inputs, not on the legend or the labels', () => {
    show({ language: 'en', legend: 'Address (English)' })
    for (const el of screen.getAllByRole('textbox')) expect(el.getAttribute('lang')).toBe('en')
    expect(screen.getByRole('group').closest('[lang]')).toBeNull()
  })

  it('has no axe violation, clean or with errors and a fifth line', async () => {
    const { container } = show({
      lines: ['1', '2', '3', '4', '5'],
      errors: new Map([[4, ['Too many lines: at most 4, you have 5.']]]),
    })
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(results.violations.map((v) => v.id)).toEqual([])
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listSuppliers = vi.hoisted(() => vi.fn())
vi.mock('../lib/suppliersApi', () => ({ listSuppliers }))

import SupplierField from './SupplierField'

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="supplier">Supplier</label>
      <SupplierField id="supplier" value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  )
}

const input = () => screen.getByLabelText('Supplier') as HTMLInputElement
const optionLabels = () => screen.queryAllByRole('option').map((o) => o.textContent)
const mount = async (initial?: string) => {
  render(<Harness initial={initial} />)
  await act(async () => {})
}

beforeEach(() => {
  listSuppliers.mockReset()
  listSuppliers.mockResolvedValue({ suppliers: ['Acer', 'Apple', 'Digitec', 'Dell Technologies'] })
})
afterEach(cleanup)

describe('SupplierField', () => {
  it('fetches the suppliers once and shows nothing until the user types', async () => {
    await mount()
    expect(listSuppliers).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('suggests the suppliers containing what is typed, case-insensitively, and announces the count', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'de' } })
    expect(optionLabels()).toEqual(['Dell Technologies'])
    fireEvent.change(input(), { target: { value: 'A' } })
    expect(optionLabels()).toEqual(['Acer', 'Apple'])
    expect(screen.getByTestId('supplier-live').textContent).toBe('2 supplier suggestions available')
  })

  it('picking a suggestion fills the field and closes the list', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'dig' } })
    fireEvent.click(screen.getByRole('option', { name: 'Digitec' }))
    expect(screen.getByTestId('value').textContent).toBe('Digitec')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keyboard: ArrowDown then Enter picks the first suggestion', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'ap' } })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('Apple')
  })

  it('stays free text: a supplier nobody used is kept as typed, with no list and no "no matches" row', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'Brack' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByTestId('value').textContent).toBe('Brack')
  })

  it('offers nothing when the only match is exactly what is typed', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'Acer' } })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ArrowDown on an untouched field opens the whole list', async () => {
    await mount()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(optionLabels()).toEqual(['Acer', 'Apple', 'Digitec', 'Dell Technologies'])
  })

  it('closes on blur', async () => {
    await mount()
    fireEvent.change(input(), { target: { value: 'a' } })
    fireEvent.blur(input())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a failed lookup is silent: the field is a plain text input', async () => {
    listSuppliers.mockRejectedValue(new Error('down'))
    await mount()
    fireEvent.change(input(), { target: { value: 'a' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('value').textContent).toBe('a')
  })

  it('a client that throws synchronously degrades the same way', async () => {
    listSuppliers.mockImplementation(() => {
      throw new Error('no session')
    })
    await mount('Acer')
    expect(input().value).toBe('Acer')
  })
})

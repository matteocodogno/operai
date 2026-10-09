/**
 * @vitest-environment jsdom
 *
 * Component tests for AssetFilterBar (T29, specs/015-hardware-inventory;
 * design.md § T1, F7, § Accessibility "T1 list"; refs AC-3.7, AC-3.8, AC-10.3,
 * AC-12.10).
 *
 * The bar is controlled: it renders `values` and reports each change through
 * `onChange`. Text inputs are debounced (300 ms by default); the invoice
 * reference also applies on Enter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import AssetFilterBar, { type AssetFilterBarProps } from './AssetFilterBar'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const baseProps = (over: Partial<AssetFilterBarProps> = {}): AssetFilterBarProps => ({
  values: { toVerify: false, invoiceRef: '', q: '' },
  entities: ['welld_ch'],
  canFilterByHolder: false,
  holderOptions: [],
  onChange: vi.fn(),
  ...over,
})

describe('structure and tab order', () => {
  it('is a labelled search form and the search input precedes every filter control', () => {
    render(<AssetFilterBar {...baseProps({ canFilterByHolder: true, entities: ['welld_ch', 'welld_it'] })} />)

    expect(screen.getByRole('search', { name: 'Filter assets' })).not.toBeNull()
    const controls = Array.from(
      screen.getByRole('search').querySelectorAll<HTMLElement>('input, select, textarea, button'),
    ).map((el) => el.id)
    expect(controls[0]).toBe('asset-filter-q')
    expect(controls.indexOf('asset-filter-q')).toBeLessThan(controls.indexOf('asset-filter-status'))
    expect(controls.indexOf('asset-filter-q')).toBeLessThan(controls.indexOf('asset-filter-invoice-ref'))
  })

  it('gives every control a visible label', () => {
    render(<AssetFilterBar {...baseProps({ canFilterByHolder: true, entities: ['welld_ch', 'welld_it'] })} />)

    for (const name of ['Search', 'Status', 'Category', 'Entity', 'Holder', 'To verify', 'Invoice reference']) {
      expect(screen.getByLabelText(name)).not.toBeNull()
    }
  })
})

describe('capability and scope gating (absent, never disabled)', () => {
  it('omits the holder filter without asset:manage', () => {
    render(<AssetFilterBar {...baseProps({ canFilterByHolder: false })} />)
    expect(screen.queryByLabelText('Holder')).toBeNull()
  })

  it('omits the entity filter with one entity in scope and shows it with two', () => {
    const { rerender } = render(<AssetFilterBar {...baseProps({ entities: ['welld_ch'] })} />)
    expect(screen.queryByLabelText('Entity')).toBeNull()

    rerender(<AssetFilterBar {...baseProps({ entities: ['welld_ch', 'welld_it'] })} />)
    expect(screen.getByLabelText('Entity')).not.toBeNull()
  })
})

describe('select and checkbox changes', () => {
  it('reports a status change and clears it again', () => {
    const onChange = vi.fn()
    render(<AssetFilterBar {...baseProps({ onChange })} />)

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'assigned' } })
    expect(onChange).toHaveBeenLastCalledWith({ status: 'assigned' })

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ status: undefined })
  })

  it('reports category, entity and holder changes', () => {
    const onChange = vi.fn()
    render(
      <AssetFilterBar
        {...baseProps({
          onChange,
          canFilterByHolder: true,
          entities: ['welld_ch', 'welld_it'],
          holderOptions: [{ id: 'u1', label: 'Anna Rossi' }],
        })}
      />,
    )

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'laptop' } })
    expect(onChange).toHaveBeenLastCalledWith({ category: 'laptop' })
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'welld_it' } })
    expect(onChange).toHaveBeenLastCalledWith({ entity: 'welld_it' })
    fireEvent.change(screen.getByLabelText('Holder'), { target: { value: 'u1' } })
    expect(onChange).toHaveBeenLastCalledWith({ holderUserId: 'u1' })
  })

  it('reports the "To verify" checkbox', () => {
    const onChange = vi.fn()
    render(<AssetFilterBar {...baseProps({ onChange })} />)

    fireEvent.click(screen.getByLabelText('To verify'))
    expect(onChange).toHaveBeenLastCalledWith({ toVerify: true })
  })

  it('shows the current values', () => {
    render(
      <AssetFilterBar
        {...baseProps({
          values: { status: 'lost', category: 'phone', toVerify: true, invoiceRef: 'INV-1', q: 'mac' },
        })}
      />,
    )
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('lost')
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('phone')
    expect((screen.getByLabelText('To verify') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Invoice reference') as HTMLInputElement).value).toBe('INV-1')
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('mac')
  })

  it('keeps an unlisted holder id selectable instead of silently showing "Any holder"', () => {
    render(
      <AssetFilterBar
        {...baseProps({
          canFilterByHolder: true,
          holderOptions: [{ id: 'u1', label: 'Anna Rossi' }],
          values: { holderUserId: 'gone', toVerify: false, invoiceRef: '', q: '' },
        })}
      />,
    )
    const select = screen.getByLabelText('Holder') as HTMLSelectElement
    expect(select.value).toBe('gone')
    expect(select.selectedOptions[0].textContent).toBe('Unknown user')
  })
})

describe('debounced text inputs', () => {
  it('does not report the search text until 300 ms have passed, then reports it once', () => {
    const onChange = vi.fn()
    render(<AssetFilterBar {...baseProps({ onChange })} />)

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'mac' } })
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'macb' } })
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ q: 'macb' })
  })

  it('applies the invoice reference at once on Enter and does not report it a second time', () => {
    const onChange = vi.fn()
    render(<AssetFilterBar {...baseProps({ onChange })} />)

    const input = screen.getByLabelText('Invoice reference')
    fireEvent.change(input, { target: { value: 'INV-77' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ invoiceRef: 'INV-77' })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('applies the invoice reference after the pause too, trimmed, and reports an emptied field as unset', () => {
    const onChange = vi.fn()
    render(<AssetFilterBar {...baseProps({ onChange, values: { toVerify: false, invoiceRef: 'INV-1', q: '' } })} />)

    fireEvent.change(screen.getByLabelText('Invoice reference'), { target: { value: '  ' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onChange).toHaveBeenCalledWith({ invoiceRef: '' })
  })

  it('keeps the typed text (and focus) while the URL catches up to what was committed', () => {
    const onChange = vi.fn()
    const { rerender } = render(<AssetFilterBar {...baseProps({ onChange })} />)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    input.focus()

    fireEvent.change(input, { target: { value: 'ab' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.change(input, { target: { value: 'abc' } })
    // The router now reflects the committed "ab" while the user has already typed "c".
    rerender(<AssetFilterBar {...baseProps({ onChange, values: { toVerify: false, invoiceRef: '', q: 'ab' } })} />)

    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('abc')
    expect(document.activeElement).toBe(input)
  })

  it('follows an external change of the value (Clear filters, browser back)', () => {
    const { rerender } = render(
      <AssetFilterBar {...baseProps({ values: { toVerify: false, invoiceRef: 'INV-1', q: 'mac' } })} />,
    )
    rerender(<AssetFilterBar {...baseProps({ values: { toVerify: false, invoiceRef: '', q: '' } })} />)

    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Invoice reference') as HTMLInputElement).value).toBe('')
  })

  it('does not submit the form (and reload the page) on Enter in the search box', () => {
    render(<AssetFilterBar {...baseProps()} />)
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.submit(screen.getByRole('search'))).toBe(false)
  })
})

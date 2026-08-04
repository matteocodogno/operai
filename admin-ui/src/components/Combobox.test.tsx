/**
 * @vitest-environment jsdom
 *
 * Component tests for Combobox — this repo's first ARIA combobox (T10,
 * specs/012-employee-address/tasks.md, refs AC-2.1, AC-2.2).
 *
 * Covers exactly what the task's "done when" names:
 *   (A) keyboard-only operation end-to-end (↑/↓/Home/End/Enter/Escape).
 *   (B) `aria-activedescendant` tracks the active option.
 *   (C) result count is announced (the `aria-live="polite"` region).
 *   (D) focus returns correctly on selection (stays on the input).
 *   (E) selection is provably not mouse-only — the whole "select an option"
 *       flow in one test uses ONLY keyboard events, never `fireEvent.click`
 *       or `fireEvent.mouseDown`.
 *
 * Strategy: a small stateful harness wraps `Combobox` the way a real
 * consumer (`AddressSection.tsx`, T11) would — `isOpen`/`value` live in the
 * harness's own `useState`, mirroring how open/closed is fully
 * caller-controlled per this component's design. Assertions use plain DOM
 * APIs (`getAttribute`, `.value`, `.textContent`) rather than jest-dom
 * matchers — this repo has no jest-dom dependency (see
 * ConfirmDeleteModal.test.tsx for the established convention).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import Combobox from './Combobox'
import type { ComboboxOption } from './Combobox'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const OPTIONS: ComboboxOption[] = [
  { id: 'a', label: 'Bahnhofstrasse 1', secondaryLabel: 'Zürich, Switzerland' },
  { id: 'b', label: 'Bahnhofstrasse 2', secondaryLabel: 'Zürich, Switzerland' },
  { id: 'c', label: 'Bahnhofstrasse 3', secondaryLabel: 'Zürich, Switzerland' },
]

function Harness({
  options = OPTIONS,
  onSelect,
  liveRegionText = '',
  disabled = false,
}: {
  options?: ComboboxOption[]
  onSelect: (option: ComboboxOption) => void
  liveRegionText?: string
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Combobox
      id="test-combobox"
      value={value}
      onValueChange={setValue}
      options={options}
      onSelect={(option) => {
        setValue(option.label)
        onSelect(option)
      }}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      aria-label="Street"
      liveRegionText={liveRegionText}
      emptyState="No matching suggestions"
      disabled={disabled}
      testId="street-combobox"
    />
  )
}

describe('Combobox', () => {
  it('renders as an ARIA combobox with the popup closed initially', () => {
    render(<Harness onSelect={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Street' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ArrowDown opens the popup and activates the first option, tracked via aria-activedescendant', () => {
    render(<Harness onSelect={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })

    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox')).not.toBeNull()

    const firstOption = screen.getByTestId('street-combobox-option-a')
    expect(input.getAttribute('aria-activedescendant')).toBe(firstOption.id)
  })

  it('ArrowDown repeatedly wraps from the last option back to the first', () => {
    render(<Harness onSelect={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' }) // -> a
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // -> b
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // -> c
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // wraps -> a

    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByTestId('street-combobox-option-a').id)
  })

  it('ArrowUp wraps from the first option to the last', () => {
    render(<Harness onSelect={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' }) // -> a
    fireEvent.keyDown(input, { key: 'ArrowUp' }) // wraps -> c

    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByTestId('street-combobox-option-c').id)
  })

  it('Home jumps to the first option and End jumps to the last', () => {
    render(<Harness onSelect={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' }) // open, -> a
    fireEvent.keyDown(input, { key: 'End' })
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByTestId('street-combobox-option-c').id)

    fireEvent.keyDown(input, { key: 'Home' })
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByTestId('street-combobox-option-a').id)
  })

  it('Escape closes the popup without altering the value or selecting anything', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const input = screen.getByRole('combobox', { name: 'Street' }) as HTMLInputElement

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(onSelect).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('Tab closes the popup and does NOT select the active option', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })

    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('E — selection is provably keyboard-only: ArrowDown then Enter selects, with zero mouse events fired', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const input = screen.getByRole('combobox', { name: 'Street' }) as HTMLInputElement
    input.focus()

    // Only keyboard events in this entire test — no fireEvent.click / mouseDown anywhere.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // -> b
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(OPTIONS[1])
    // (D) focus returns / stays on the input after selection — never moved into the (now-closed) popup.
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('a mouse click on an option also selects it (both paths work, mouse is not required)', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const input = screen.getByRole('combobox', { name: 'Street' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('street-combobox-option-c'))

    expect(onSelect).toHaveBeenCalledWith(OPTIONS[2])
    expect(document.activeElement).toBe(input)
  })

  it('(C) announces the caller-provided liveRegionText (e.g. a result count)', () => {
    render(<Harness onSelect={vi.fn()} liveRegionText="3 suggestions available" />)
    expect(screen.getByTestId('street-combobox-live').textContent).toBe('3 suggestions available')
  })

  it('renders the caller-provided emptyState when options is empty and the popup is explicitly opened (AC-3.1)', () => {
    // The popup only opens here because the caller (not this component) decided
    // to — e.g. a completed search that genuinely found zero results (AC-3.1),
    // as opposed to AC-3.2's degraded case where the caller simply never opens
    // it at all. Rendered with isOpen pinned to true to prove that distinction
    // is entirely the caller's to make.
    render(
      <Combobox
        id="empty-combobox"
        value="xyz"
        onValueChange={vi.fn()}
        options={[]}
        onSelect={vi.fn()}
        isOpen
        onOpenChange={vi.fn()}
        aria-label="Street"
        emptyState="No matching suggestions"
        testId="empty-combobox"
      />,
    )
    expect(screen.getByRole('listbox').textContent).toContain('No matching suggestions')
  })

  it('when disabled, keyboard interaction is inert and the input is not editable', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} disabled />)
    const input = screen.getByRole('combobox', { name: 'Street' }) as HTMLInputElement

    expect(input.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(input, { target: { value: 'x' } })
    expect(input.value).toBe('')
  })
})

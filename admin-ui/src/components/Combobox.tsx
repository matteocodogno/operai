/**
 * Combobox — an accessible ARIA combobox-with-listbox primitive (T10,
 * specs/012-employee-address/tasks.md, refs AC-2.1, AC-2.2; design.md
 * "Accessibility — The Street/address combobox — the hard part" and
 * "Country control — resolved design↔plan mismatch").
 *
 * This repo's FIRST ARIA combobox (design.md confirmed none exists anywhere
 * in `admin-ui`, `shell`, `refund-ui`, `notify-ui`, `estimai-ui`) — built
 * ONCE, parameterized, and reused by BOTH `AddressSection.tsx` consumers
 * (T11): the Street/address field (async, Google-backed, debounced) and the
 * Country field (sync, local ISO-list filter). A second, parallel
 * implementation is explicitly rejected by design.md ("duplicate roughly a
 * dozen a11y-load-bearing behaviors for zero UX benefit").
 *
 * This component is deliberately "dumb": it owns keyboard navigation,
 * `aria-activedescendant` tracking, and the WAI-ARIA wiring, but NOT when
 * the popup opens/closes, what to show for an empty result, or what a
 * status announcement should say — those are supplied by the caller
 * (`isOpen`, `emptyState`, `liveRegionText`), because the Street field's
 * AC-3.1-vs-AC-3.2 distinction (a calm "no results" caption vs.
 * deliberately nothing at all) can only be decided by whoever knows WHY the
 * result list is empty, which this component does not and should not know.
 *
 * Implements the WAI-ARIA "combobox with listbox popup" pattern:
 *   - `<input role="combobox" aria-expanded aria-controls aria-autocomplete="list">`.
 *   - A real `<ul role="listbox">` popup; each option a `<li role="option">`
 *     with a stable, predictable id.
 *   - DOM focus never leaves the input — keyboard highlighting moves via
 *     `aria-activedescendant`, the WAI-ARIA-correct alternative to moving
 *     real focus into the list (this is what makes "keep typing while
 *     suggestions are open" work at all).
 *   - Keyboard contract (2.1.1 Keyboard): ArrowDown/ArrowUp move the active
 *     option (wrapping); Home/End jump to first/last; Enter selects the
 *     active option; Escape closes the popup without altering the typed
 *     text or selection; Tab closes the popup and moves focus onward
 *     normally WITHOUT selecting — an explicit Enter or a click is always
 *     required to select (mouse is never the only path — the reverse is
 *     also true: this component never requires a mouse at all).
 *   - A visually-hidden `aria-live="polite"` region announces
 *     `liveRegionText` (result count / no-match) — entirely separate from
 *     the listbox itself, and never used for a state the caller wants to
 *     stay silent about (AC-3.2 passes an empty string).
 */

import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

export type ComboboxOption = {
  id: string
  label: string
  secondaryLabel?: string
}

export type ComboboxProps = {
  /** Base id this instance derives its listbox/option/live-region ids from — must be unique per rendered instance. */
  id: string
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  onSelect: (option: ComboboxOption) => void
  /** Whether the popup should render at all — fully caller-controlled (see module doc comment). */
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  disabled?: boolean
  'aria-label'?: string
  ariaInvalid?: boolean
  ariaDescribedBy?: string
  /** Rendered inside the popup in place of the option list when `options.length === 0` — omit entirely (undefined) for AC-3.2's deliberately silent state. */
  emptyState?: React.ReactNode
  /** Rendered as a persistent footer row inside the popup whenever it's open (Google attribution — Street only, design.md). */
  footer?: React.ReactNode
  /** Text for the visually-hidden `aria-live="polite"` announcement — '' announces nothing. */
  liveRegionText?: string
  testId?: string
}

export default function Combobox({
  id,
  value,
  onValueChange,
  options,
  onSelect,
  isOpen,
  onOpenChange,
  onFocus,
  onBlur,
  placeholder,
  disabled = false,
  'aria-label': ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  emptyState,
  footer,
  liveRegionText = '',
  testId,
}: ComboboxProps) {
  const reactId = useId()
  const baseId = id || reactId
  const listboxId = `${baseId}-listbox`
  const liveRegionId = `${baseId}-live`

  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const localInputRef = useRef<HTMLInputElement | null>(null)

  const activeOptionId =
    isOpen && activeIndex !== null && options[activeIndex] ? `${baseId}-option-${options[activeIndex].id}` : undefined

  const selectOption = useCallback(
    (option: ComboboxOption) => {
      onSelect(option)
      onOpenChange(false)
      setActiveIndex(null)
      // Focus never leaves the input, on selection or otherwise (design.md:
      // "focus stays programmatically on the <input>").
      localInputRef.current?.focus()
    },
    [onSelect, onOpenChange],
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return
    setActiveIndex(null)
    onValueChange(e.target.value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (options.length === 0) return
      if (!isOpen) onOpenChange(true)
      setActiveIndex((prev) => (prev === null ? 0 : (prev + 1) % options.length))
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length === 0) return
      if (!isOpen) onOpenChange(true)
      setActiveIndex((prev) => (prev === null ? options.length - 1 : (prev - 1 + options.length) % options.length))
      return
    }

    if (e.key === 'Home') {
      if (!isOpen || options.length === 0) return
      e.preventDefault()
      setActiveIndex(0)
      return
    }

    if (e.key === 'End') {
      if (!isOpen || options.length === 0) return
      e.preventDefault()
      setActiveIndex(options.length - 1)
      return
    }

    if (e.key === 'Enter') {
      if (!isOpen || activeIndex === null) return
      const option = options[activeIndex]
      if (!option) return
      e.preventDefault()
      selectOption(option)
      return
    }

    if (e.key === 'Escape') {
      if (!isOpen) return
      e.preventDefault()
      onOpenChange(false)
      setActiveIndex(null)
      return
    }

    // Tab: close the popup and let focus move on normally — never selects
    // (design.md: "a focus-out can never silently apply an unintended
    // suggestion"). No preventDefault — default Tab behavior proceeds.
    if (e.key === 'Tab' && isOpen) {
      onOpenChange(false)
      setActiveIndex(null)
    }
  }

  const handleOptionMouseDown = (e: React.MouseEvent) => {
    // Prevent the input from blurring before the click's onSelect fires.
    e.preventDefault()
  }

  return (
    <div className="relative">
      <input
        ref={localInputRef}
        id={baseId}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled || undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        readOnly={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        data-testid={testId}
        className="w-full border rounded-md px-3 py-2 text-sm"
        style={{
          borderColor: ariaInvalid ? 'var(--red)' : 'var(--rule)',
          backgroundColor: 'var(--ink-mid)',
          color: 'var(--text)',
          opacity: disabled ? 0.6 : 1,
        }}
      />

      <p id={liveRegionId} aria-live="polite" className="sr-only" data-testid={testId ? `${testId}-live` : undefined}>
        {liveRegionText}
      </p>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          data-testid={testId ? `${testId}-listbox` : undefined}
          className="absolute z-10 mt-1 w-full border rounded-md shadow-lg max-h-64 overflow-y-auto text-sm"
          style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        >
          {options.length === 0 && emptyState !== undefined && (
            <li className="px-3 py-2" style={{ color: 'var(--soft)' }} aria-disabled="true">
              {emptyState}
            </li>
          )}

          {options.map((option, index) => {
            const optionId = `${baseId}-option-${option.id}`
            const isActive = index === activeIndex
            return (
              <li
                key={option.id}
                id={optionId}
                role="option"
                aria-selected={isActive}
                data-testid={testId ? `${testId}-option-${option.id}` : undefined}
                className="px-3 py-2 cursor-pointer"
                style={{
                  backgroundColor: isActive ? 'color-mix(in srgb, var(--acc) 15%, transparent)' : 'transparent',
                  color: 'var(--text)',
                }}
                onMouseDown={handleOptionMouseDown}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <div>{option.label}</div>
                {option.secondaryLabel && (
                  <div className="text-xs" style={{ color: 'var(--soft)' }}>
                    {option.secondaryLabel}
                  </div>
                )}
              </li>
            )
          })}

          {footer}
        </ul>
      )}
    </div>
  )
}

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'

export type ComboboxOption = {
  id: string
  label: string
  secondaryLabel?: string
}

export type ComboboxProps = {
  /** Base id for the input; the listbox, options and live region derive theirs from it. Unique per instance. */
  id: string
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  onSelect: (option: ComboboxOption) => void
  /** Whether the popup renders: the caller decides (it knows when there is something to show). */
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  disabled?: boolean
  'aria-label'?: string
  /** From a `Field`'s control props, or set directly when the combobox stands alone. */
  ariaInvalid?: boolean
  ariaDescribedBy?: string
  ariaRequired?: boolean
  /**
   * Shown in the popup instead of the options when there are none (a "no match" or a
   * loading/error line). Leave undefined for a deliberately silent empty popup.
   */
  emptyState?: ReactNode
  /** A row at the end of the popup whenever it is open (an attribution, a hint). */
  footer?: ReactNode
  /** Announced politely by screen readers (a result count, "no match"); '' announces nothing. */
  liveRegionText?: string
  /** data-testid on the input; `-listbox`, `-live` and `-option-<id>` are derived from it. */
  testId?: string
}

/**
 * Combobox — a text input with a list of suggestions (the WAI-ARIA "combobox
 * with listbox popup" pattern). Focus never leaves the input: the highlighted
 * option moves through `aria-activedescendant`, so the person can keep typing
 * while suggestions are open.
 *
 * Keyboard: ↓/↑ move (wrapping) and open the popup, Home/End jump, Enter
 * selects, Escape closes without changing the text, Tab closes WITHOUT
 * selecting. A click also selects; nothing requires a mouse.
 *
 * Deliberately "dumb": the caller owns the text, the options, when the popup
 * is open, what an empty result says and what is announced, because only the
 * caller knows why the list is empty (still loading, no match, rate-limited).
 */
export function Combobox({
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
  ariaRequired,
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
  const inputRef = useRef<HTMLInputElement | null>(null)

  const activeOptionId =
    isOpen && activeIndex !== null && options[activeIndex] ? `${baseId}-option-${options[activeIndex].id}` : undefined

  // `aria-activedescendant` does not scroll the popup: keep the highlighted option in view.
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])

  const selectOption = useCallback(
    (option: ComboboxOption) => {
      onSelect(option)
      onOpenChange(false)
      setActiveIndex(null)
      inputRef.current?.focus()
    },
    [onSelect, onOpenChange],
  )

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (disabled) return
    setActiveIndex(null)
    onValueChange(e.target.value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (options.length === 0) return
        if (!isOpen) onOpenChange(true)
        setActiveIndex((prev) => (prev === null ? 0 : (prev + 1) % options.length))
        return
      case 'ArrowUp':
        e.preventDefault()
        if (options.length === 0) return
        if (!isOpen) onOpenChange(true)
        setActiveIndex((prev) => (prev === null ? options.length - 1 : (prev - 1 + options.length) % options.length))
        return
      case 'Home':
      case 'End':
        if (!isOpen || options.length === 0) return
        e.preventDefault()
        setActiveIndex(e.key === 'Home' ? 0 : options.length - 1)
        return
      case 'Enter': {
        const option = isOpen && activeIndex !== null ? options[activeIndex] : undefined
        if (!option) return
        e.preventDefault()
        selectOption(option)
        return
      }
      case 'Escape':
        if (!isOpen) return
        e.preventDefault()
        // The popup used this Escape: a dialog around the field listens on the window and must
        // not close with it. The next Escape, with the popup closed, reaches the dialog.
        e.stopPropagation()
        onOpenChange(false)
        setActiveIndex(null)
        return
      case 'Tab':
        // Closes and lets focus move on: leaving the field never applies a suggestion.
        if (isOpen) {
          onOpenChange(false)
          setActiveIndex(null)
        }
        return
      default:
        return
    }
  }

  // Keeps the input focused (no blur) until the option's click has selected it.
  const keepInputFocus = (e: MouseEvent) => e.preventDefault()

  return (
    <div className="combobox">
      <input
        ref={inputRef}
        id={baseId}
        type="text"
        role="combobox"
        className="combobox-input"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        aria-required={ariaRequired || undefined}
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
      />

      <p id={liveRegionId} aria-live="polite" className="visually-hidden" data-testid={testId && `${testId}-live`}>
        {liveRegionText}
      </p>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          className="combobox-listbox"
          data-testid={testId && `${testId}-listbox`}
          onMouseDown={keepInputFocus}
        >
          {options.length === 0 && emptyState !== undefined && (
            <li className="combobox-empty" aria-disabled="true">
              {emptyState}
            </li>
          )}

          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${baseId}-option-${option.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className="combobox-option"
              data-testid={testId && `${testId}-option-${option.id}`}
              onMouseDown={keepInputFocus}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
            >
              <div>{option.label}</div>
              {option.secondaryLabel && <div className="combobox-option-secondary">{option.secondaryLabel}</div>}
            </li>
          ))}

          {footer}
        </ul>
      )}
    </div>
  )
}

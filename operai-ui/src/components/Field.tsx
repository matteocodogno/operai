import { useId } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'

/** The props a Field hands to its control: spread them on the input, select or textarea. */
export type FieldControlProps = {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
  'aria-required': true | undefined
}

export type FieldProps = {
  label: ReactNode
  /** A fixed id for the control, when something else must address it (a combobox's listbox ids). Generated otherwise. */
  id?: string
  /** An id for the `<label>`, when something else is named by it (FilePicker's group, via `aria-labelledby`). */
  labelId?: string
  /** Help text under the control. */
  hint?: ReactNode
  /** The field's error (from validation or a 422). The hint stays. */
  error?: ReactNode
  /** Shows the `*` marker (aria-hidden) and sets `aria-required`, which screen readers announce as "required". */
  required?: boolean
  className?: string
  testId?: string
  errorTestId?: string
  /** `alert` announces the error as it appears (a server-side error after submit). */
  errorRole?: 'alert'
  children: (control: FieldControlProps) => ReactNode
}

/**
 * Field — label + control + hint + error, wired together: the label points at
 * the control, the hint and error describe it, an error marks it invalid.
 * Label above the control, error under it, always.
 *
 *   <Field label={t.amount} error={errors.amount} required>
 *     {(control) => <input {...control} inputMode="decimal" value={…} onChange={…} />}
 *   </Field>
 */
export function Field({
  label,
  id: fixedId,
  labelId,
  hint,
  error,
  required = false,
  className,
  testId,
  errorTestId,
  errorRole,
  children,
}: FieldProps) {
  const generatedId = useId()
  const id = fixedId ?? generatedId
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className={cx('field', className)} data-testid={testId}>
      <label id={labelId} htmlFor={id} className="field-label">
        {label}
        {required && (
          <span aria-hidden="true" className="field-required">
            *
          </span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role={errorRole} className="field-error" data-testid={errorTestId}>
          {error}
        </p>
      )}
    </div>
  )
}

export type RadioGroupFieldProps = {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  testId?: string
  errorTestId?: string
  /** The radios, each `<label><input type="radio" name=… /> …</label>`. */
  children: ReactNode
}

/**
 * RadioGroupField — a group of radios with the same label, hint, required and
 * error wiring as `Field`: a `radiogroup` labelled by its label, described by
 * the hint and the error, `aria-invalid` when the error is set.
 */
export function RadioGroupField({
  label,
  hint,
  error,
  required = false,
  className,
  testId,
  errorTestId,
  children,
}: RadioGroupFieldProps) {
  const id = useId()
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
  return (
    <div
      role="radiogroup"
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      className={cx('field', className)}
      data-testid={testId}
    >
      <span id={`${id}-label`} className="field-label">
        {label}
        {required && (
          <span aria-hidden="true" className="field-required">
            *
          </span>
        )}
      </span>
      <div className="radio-options">{children}</div>
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error" data-testid={errorTestId}>
          {error}
        </p>
      )}
    </div>
  )
}

export type CheckboxOption = {
  id: string
  label: ReactNode
}

export type CheckboxGroupFieldProps = {
  /** The group's legend. */
  label: ReactNode
  /** Keep the legend for assistive technology only — when a visible heading (a Card title) already names the group. */
  hideLabel?: boolean
  hint?: ReactNode
  error?: ReactNode
  options: readonly CheckboxOption[]
  /** Ids of the ticked options. */
  selected: ReadonlySet<string> | readonly string[]
  onToggle: (id: string, checked: boolean) => void
  /** Disables every checkbox (in flight). */
  disabled?: boolean
  /** Shown instead of the list when there are no options. */
  emptyState?: ReactNode
  /** Caps the list's height and scrolls it — inside a dialog. */
  scroll?: boolean
  className?: string
  testId?: string
  /** data-testid of each checkbox: `${prefix}-${option.id}`. */
  optionTestIdPrefix?: string
}

/**
 * CheckboxGroupField — pick any number of options from a list (roles,
 * departments, items to link): a `<fieldset>` whose legend names the group,
 * one labelled checkbox per line, described by the hint and the error.
 */
export function CheckboxGroupField({
  label,
  hideLabel = false,
  hint,
  error,
  options,
  selected,
  onToggle,
  disabled = false,
  emptyState,
  scroll = false,
  className,
  testId,
  optionTestIdPrefix,
}: CheckboxGroupFieldProps) {
  const id = useId()
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
  const isSelected = (optionId: string) =>
    selected instanceof Set ? selected.has(optionId) : (selected as readonly string[]).includes(optionId)
  return (
    <fieldset
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className={cx('field checkbox-group', className)}
      data-testid={testId}
    >
      <legend className={hideLabel ? 'visually-hidden' : 'field-label'}>{label}</legend>
      {options.length === 0 ? (
        emptyState && <p className="checkbox-group-empty">{emptyState}</p>
      ) : (
        <div className={cx('checkbox-options', scroll && 'checkbox-options-scroll')}>
          {options.map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={isSelected(option.id)}
                onChange={(event) => onToggle(option.id, event.target.checked)}
                data-testid={optionTestIdPrefix ? `${optionTestIdPrefix}-${option.id}` : undefined}
              />
              {option.label}
            </label>
          ))}
        </div>
      )}
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  )
}

/**
 * Moves focus to the first invalid control inside `container` (after a failed
 * submit, design-system.md § Forms): the first `[aria-invalid="true"]` control,
 * or, for an invalid radio group, its checked radio, else its first one.
 * Returns whether something was focused.
 */
export function focusFirstInvalid(container: HTMLElement | null): boolean {
  const invalid = container?.querySelector<HTMLElement>('[aria-invalid="true"]')
  if (!invalid) return false
  const target =
    invalid.getAttribute('role') === 'radiogroup'
      ? (invalid.querySelector<HTMLElement>('input[type="radio"]:checked') ??
        invalid.querySelector<HTMLElement>('input[type="radio"]'))
      : invalid
  target?.focus()
  return target !== null && target !== undefined
}

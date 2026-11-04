import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import { formatNumber } from '../lib/format'
import { Button } from './Button'
import { Field } from './Field'
import { Icon } from './Icon'

export type FilePickerProps = {
  /** The field label. The choose button is the labelled control. */
  label: ReactNode
  /** The choose button's text ("Choose file"). */
  chooseLabel: string
  /** The accessible name of the clear button ("Remove file"). */
  clearLabel: string
  /** What the line says while nothing is chosen ("No file chosen"). */
  emptyText: string
  /** The current selection. Controlled: the app owns it, and resets it with `null`. */
  file: File | null
  onChange: (file: File | null) => void
  /** The `accept` list for the file dialog (a hint to the browser, not validation: the app checks the file). */
  accept?: string
  hint?: ReactNode
  /** The field's error: a failed pre-check or a server rejection. */
  error?: ReactNode
  required?: boolean
  disabled?: boolean
  /** Overrides the "2.4 MB" text shown after the name. */
  formatSize?: (bytes: number) => string
  className?: string
  testId?: string
  /** For the hidden `<input type="file">`, which is what Playwright's `setInputFiles` targets. */
  inputTestId?: string
  chooseTestId?: string
  clearTestId?: string
}

const KB = 1024

/** "512 byte", "20 kB", "2.4 MB", "3 GB" in the language. Binary steps, as file managers show them. */
const defaultFormatSize = (bytes: number): string => {
  const [value, unit] =
    bytes < KB
      ? [bytes, 'byte']
      : bytes < KB ** 2
        ? [bytes / KB, 'kilobyte']
        : bytes < KB ** 3
          ? [bytes / KB ** 2, 'megabyte']
          : [bytes / KB ** 3, 'gigabyte']
  return formatNumber(value, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  })
}

/**
 * FilePicker — choose one file: a visually hidden `<input type="file">`, a
 * `Button` that opens it (so mouse, Enter and Space all work), a line with the
 * chosen file's name and size, and a clear button. Wrapped in `Field`, so the
 * label, hint and error are wired to the button through `aria-describedby`.
 *
 * It only picks. Checking the type, the size or the length, uploading, and the
 * progress are the app's: pass a failed check as `error`. A cancelled file
 * dialog changes nothing. The selected line is a polite live region so the
 * choice is announced; clearing returns focus to the choose button.
 */
export function FilePicker({
  label,
  chooseLabel,
  clearLabel,
  emptyText,
  file,
  onChange,
  accept,
  hint,
  error,
  required,
  disabled,
  formatSize = defaultFormatSize,
  className,
  testId,
  inputTestId,
  chooseTestId,
  clearTestId,
}: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null)
  const choose = useRef<HTMLButtonElement>(null)
  const lineId = useId()

  // The browser keeps the old selection in the input, and does not fire `change` for the same file again:
  // whenever the app resets the file, empty the input too.
  useEffect(() => {
    if (!file && input.current && input.current.value !== '') input.current.value = ''
  }, [file])

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={cx('file-picker', className)}
      testId={testId}
    >
      {(control) => (
        <>
          <input
            ref={input}
            type="file"
            accept={accept}
            disabled={disabled}
            tabIndex={-1}
            aria-hidden="true"
            className="visually-hidden"
            data-testid={inputTestId}
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              // Cancelling the dialog empties the list in some browsers: that is not a choice.
              if (chosen) onChange(chosen)
            }}
          />
          <div className="file-picker-row">
            <Button
              ref={choose}
              size="sm"
              id={control.id}
              aria-describedby={[control['aria-describedby'], lineId].filter(Boolean).join(' ')}
              aria-invalid={control['aria-invalid']}
              aria-required={control['aria-required']}
              disabled={disabled}
              data-testid={chooseTestId}
              onClick={() => input.current?.click()}
            >
              <Icon name="upload" /> {chooseLabel}
            </Button>
            <span id={lineId} className="file-picker-line" aria-live="polite">
              {file ? (
                <>
                  <span className="file-picker-name">{file.name}</span>
                  <span className="file-picker-size">{formatSize(file.size)}</span>
                </>
              ) : (
                <span className="file-picker-empty">{emptyText}</span>
              )}
            </span>
            {file && (
              <Button
                iconOnly
                size="sm"
                variant="ghost"
                aria-label={clearLabel}
                disabled={disabled}
                data-testid={clearTestId}
                onClick={() => {
                  if (input.current) input.current.value = ''
                  onChange(null)
                  choose.current?.focus()
                }}
              >
                <Icon name="close" />
              </Button>
            )}
          </div>
        </>
      )}
    </Field>
  )
}

import { cx } from '../lib/cx'

export type ProgressBarProps = {
  /** The accessible name: what is progressing ("Uploading the recording"). Required; it is not drawn. */
  label: string
  /**
   * How far along, `0`…`max`. Omit it (or pass a non-finite number) for an
   * indeterminate bar: the work is running but its length is unknown.
   */
  value?: number
  /** The top of the scale. Defaults to 100 (a percentage); a value that is not a positive number falls back to 100. */
  max?: number
  /**
   * The text alternative to the number ("3 of 5", "62%", "Transcribing…"):
   * becomes `aria-valuetext` and is also shown beside the bar. Format any
   * figure in it with the library formatters.
   */
  valueText?: string
  className?: string
}

/**
 * ProgressBar — a determinate or indeterminate progress indicator
 * (`role="progressbar"`). A determinate bar exposes `aria-valuenow`; an
 * indeterminate one deliberately has none. The shown `valueText` is hidden from
 * assistive technology because `aria-valuetext` already carries it. The
 * indeterminate sweep stops under reduced motion and becomes a static segment.
 *
 * It does not announce changes on its own: pair a long operation with a polite
 * live region (`VisuallyHidden live`) that speaks at coarse steps.
 */
export function ProgressBar({ label, value, max, valueText, className }: ProgressBarProps) {
  const top = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : 100
  const determinate = typeof value === 'number' && Number.isFinite(value)
  const now = determinate ? Math.min(Math.max(value, 0), top) : undefined

  return (
    <div className={cx('progress', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={top}
        aria-valuenow={now}
        aria-valuetext={valueText}
        className={cx('progress-track', now === undefined && 'progress-indeterminate')}
      >
        <span className="progress-fill" style={now === undefined ? undefined : { width: `${(now / top) * 100}%` }} />
      </div>
      {valueText ? (
        <span className="progress-text" aria-hidden="true">
          {valueText}
        </span>
      ) : null}
    </div>
  )
}

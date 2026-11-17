import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import type { DialogSize } from './Dialog'

export type ConfirmDialogProps = {
  title: ReactNode
  /** What will happen, and whether it can be undone. */
  children: ReactNode
  confirmLabel: string
  /** Label while in flight ("Deleting…"). */
  busyLabel: string
  cancelLabel: string
  closeLabel: string
  /** `danger` (default) for destructive or irreversible; `primary` for a positive confirmation (Approve). */
  tone?: 'danger' | 'primary'
  /**
   * For an act that cannot be undone and moves money or closes books: the whole
   * acknowledgement sentence, the label of a checkbox that must be ticked before
   * Confirm is enabled.
   */
  acknowledgeLabel?: string
  /** Fields the act needs (a date, a reason), disabled as a group in flight; the first one takes focus. */
  fields?: ReactNode
  /**
   * Opt-in: Confirm is not available YET, for a reason the person can read — the details the question is about are
   * still loading, or could not be read. Confirm becomes `aria-disabled` (not `disabled`: it stays a focus stop) and
   * is described by this text, which is also its hidden description; a press, Enter in a field and a submit do
   * nothing. Cancel, Escape and × work as usual (this is not `busy`). Unset (default): as before. While `busy`, Confirm
   * is `disabled` and busy as always.
   */
  confirmDisabledReason?: string
  /**
   * Opt-in: the body scrolls between the header and the footer, which stay in view whatever the body's length and
   * the screen's height (320 px wide, or short). The error stays above the footer, out of the scroll. Popups that
   * open inside a field are clipped by the scrolling body: leave it off for a dialog with a combobox.
   */
  scrollBody?: boolean
  /** Opt-in: the dialog's width. Default `sm` (24 rem), or `md` (28 rem) with `fields`. `wide` is 32.5 rem (520 px). */
  size?: DialogSize
  busy: boolean
  /** Inline error from the failed request; null = none. The dialog stays open. */
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  /** data-testids: `${prefix}-backdrop`, `-close`, `-cancel`, `-confirm`, `-error`, `-checkbox`. */
  testIdPrefix?: string
  /** See Dialog's `backdropTestId`. */
  backdropTestId?: string
}

/**
 * ConfirmDialog — an `alertdialog` asking to confirm one action. Cancel takes
 * focus on open (the safe default; the first field when there are `fields`);
 * in flight the controls are disabled, the confirm button is busy and the
 * dialog cannot be dismissed. Replaces `window.confirm()` everywhere.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel,
  closeLabel,
  tone = 'danger',
  acknowledgeLabel,
  fields,
  confirmDisabledReason,
  scrollBody = false,
  size,
  busy,
  error,
  onConfirm,
  onCancel,
  testIdPrefix = 'confirm-dialog',
  backdropTestId,
}: ConfirmDialogProps) {
  const baseId = useId()
  const bodyId = `${baseId}-body`
  const checkboxId = `${baseId}-ack`
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const hasFields = fields !== undefined && fields !== null
  const reason = confirmDisabledReason !== undefined && confirmDisabledReason !== '' ? confirmDisabledReason : undefined
  // A reason makes Confirm aria-disabled (still focusable, so the reason can be read); busy and an
  // unticked acknowledgement keep the native `disabled` they always had.
  const reasonBlocks = reason !== undefined && !busy
  const canConfirm = !busy && !reasonBlocks && (acknowledgeLabel === undefined || acknowledged)
  const reasonId = `${baseId}-reason`

  const content = (
    <>
      {/* A <div>, not a <p>, so the body can hold block content. */}
      <div id={bodyId} className="dialog-body">
        {children}
      </div>
      {hasFields && (
        <fieldset disabled={busy} className="dialog-fields">
          {fields}
        </fieldset>
      )}
      {acknowledgeLabel !== undefined && (
        <div className="dialog-acknowledge">
          <input
            id={checkboxId}
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid={`${testIdPrefix}-checkbox`}
          />
          <label htmlFor={checkboxId}>{acknowledgeLabel}</label>
        </div>
      )}
    </>
  )

  return (
    <Dialog
      role="alertdialog"
      size={size ?? (hasFields ? 'md' : 'sm')}
      scrollBody={scrollBody}
      title={title}
      describedBy={bodyId}
      onClose={onCancel}
      // A dialog holding typed input ignores the backdrop, as FormDialog does:
      // a stray click must not throw away a reason the user has written.
      dismissOnBackdrop={!hasFields}
      closeLabel={closeLabel}
      busy={busy}
      initialFocusRef={hasFields ? undefined : cancelRef}
      fallbackFocusRef={cancelRef}
      testIdPrefix={testIdPrefix}
      backdropTestId={backdropTestId}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (canConfirm) onConfirm()
        }}
      >
        {scrollBody ? (
          <div className="dialog-scroll-body" tabIndex={0} data-testid={`${testIdPrefix}-scroll`}>
            {content}
          </div>
        ) : (
          content
        )}
        {error && (
          <p role="alert" className="form-error dialog-body" data-testid={`${testIdPrefix}-error`}>
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testIdPrefix}-cancel`}
          >
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant={tone}
            disabled={busy || (!reasonBlocks && !canConfirm)}
            aria-disabled={reasonBlocks || undefined}
            aria-describedby={reasonBlocks ? reasonId : undefined}
            busy={busy}
            data-testid={`${testIdPrefix}-confirm`}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
          {reasonBlocks && (
            <span id={reasonId} className="sr-only" data-testid={`${testIdPrefix}-confirm-reason`}>
              {reason}
            </span>
          )}
        </div>
      </form>
    </Dialog>
  )
}

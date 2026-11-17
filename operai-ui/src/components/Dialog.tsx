import { useId, useRef } from 'react'
import type { MouseEvent } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cx } from '../lib/cx'
import { Button } from './Button'
import { Icon } from './Icon'
import { useDialogBehavior } from './useDialogBehavior'

/** `wide` is 32.5 rem (520 px): between `md` and `lg`, for a dialog that lists labelled values. */
export type DialogSize = 'sm' | 'md' | 'lg' | 'wide'

export type DialogProps = {
  /** The dialog's heading and accessible name. */
  title: ReactNode
  /** A notice under the heading, used as the accessible description. */
  description?: ReactNode
  /** `alertdialog` for a confirmation that interrupts; `dialog` (default) for a form or content. */
  role?: 'dialog' | 'alertdialog'
  size?: DialogSize
  /** Called on ×, the backdrop (unless `dismissOnBackdrop` is false) and Escape — never while `busy`. */
  onClose: () => void
  /**
   * False: a click on the backdrop does nothing. For a dialog holding typed input, where a stray
   * click must not throw the input away (FormDialog always passes false). Escape and × still close.
   */
  dismissOnBackdrop?: boolean
  /** Accessible name of the × button. Omit for a dialog with no × (NoticeDialog's single acknowledgement). */
  closeLabel?: string
  /** In flight: not dismissible, × disabled. */
  busy?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  fallbackFocusRef?: RefObject<HTMLElement | null>
  /** Id of the element that describes the dialog, when it is not `description` (ConfirmDialog's body). */
  describedBy?: string
  /** Namespaces data-testids: `${prefix}-backdrop`, `${prefix}-close`. */
  testIdPrefix?: string
  /** data-testid on the dialog element itself (an e2e suite that locates the dialog, not its backdrop). */
  dialogTestId?: string
  /**
   * What takes focus on open. `auto` (default): `initialFocusRef`, a `data-autofocus` element,
   * the first field, `fallbackFocusRef`, then the dialog. `title`: the heading itself — for a
   * dialog that is mostly text, with no field to land on.
   */
  initialFocus?: 'auto' | 'title'
  /**
   * Opt-in. The dialog is capped at the viewport's height and its body scrolls while the header and the
   * footer stay in view — so a long body never pushes the footer's buttons off a small screen. The
   * children must be one column: a `.dialog-scroll-body` that scrolls, then the `.dialog-footer`
   * (ConfirmDialog's `scrollBody` builds it). Without it the BACKDROP scrolls, as before. A scrolling
   * body clips a popup that opens inside it, so use it for text and plain fields.
   */
  scrollBody?: boolean
  /** Overrides the backdrop's data-testid — for an app keeping the id its e2e suite already targets. */
  backdropTestId?: string
  children: ReactNode
}

/**
 * Dialog — the modal frame every Operai dialog is built on: backdrop, header
 * with title and ×, and the shared focus/keyboard contract
 * (useDialogBehavior). Mount it when open and unmount it to close — the app
 * owns the open state. Prefer ConfirmDialog or FormDialog; use Dialog directly
 * only for content that is neither.
 */
export function Dialog({
  title,
  description,
  role = 'dialog',
  size = 'md',
  onClose,
  dismissOnBackdrop = true,
  closeLabel,
  busy = false,
  initialFocusRef,
  fallbackFocusRef,
  describedBy,
  testIdPrefix = 'dialog',
  backdropTestId,
  dialogTestId,
  initialFocus = 'auto',
  scrollBody = false,
  children,
}: DialogProps) {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const backdropClick = useBackdropClick(() => {
    if (!busy && dismissOnBackdrop) onClose()
  })

  useDialogBehavior({
    dialogRef,
    onClose,
    busy,
    initialFocusRef: initialFocus === 'title' ? titleRef : initialFocusRef,
    fallbackFocusRef,
  })

  return (
    <div
      className="dialog-backdrop"
      {...backdropClick}
      data-testid={backdropTestId ?? `${testIdPrefix}-backdrop`}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy ?? (description ? descriptionId : undefined)}
        tabIndex={-1}
        className={cx('dialog', size !== 'md' && `dialog-${size}`, scrollBody && 'dialog-scroll')}
        data-testid={dialogTestId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2
            ref={titleRef}
            id={titleId}
            tabIndex={initialFocus === 'title' ? -1 : undefined}
            className="dialog-title"
          >
            {title}
          </h2>
          {closeLabel !== undefined && (
            <Button
              variant="ghost"
              iconOnly
              onClick={onClose}
              disabled={busy}
              aria-label={closeLabel}
              data-testid={`${testIdPrefix}-close`}
            >
              <Icon name="close" />
            </Button>
          )}
        </div>
        {description && (
          <div id={descriptionId} className="dialog-description">
            {description}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/**
 * Backdrop handlers that ignore a click whose press STARTED inside the panel. A plain `onClick`
 * also fires when a text selection begins in a field and the mouse is released outside the
 * dialog (the click lands on the common ancestor, the backdrop), which closed a half-filled form.
 */
export function useBackdropClick(onDismiss: () => void) {
  const pressedInside = useRef(false)
  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      pressedInside.current = event.target !== event.currentTarget
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const dismiss = !pressedInside.current && event.target === event.currentTarget
      pressedInside.current = false
      if (dismiss) onDismiss()
    },
  }
}

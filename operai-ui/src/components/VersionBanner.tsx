import { useId } from 'react'
import type { ReactNode, Ref } from 'react'
import { useFocusOnMount } from '../lib/useFocusOnMount'
import { Banner } from './Banner'
import { Button } from './Button'

export type VersionBannerProps = {
  /** "Viewing version 3 (read-only)" — the heading, which takes focus when the banner mounts. */
  title: string
  /** 2–6; the page's outline decides. Default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6
  /** Who saved it and when, that it is not the current version… — app-owned sentence(s). */
  children: ReactNode
  /** A badge beside the sentence, e.g. "Not current". */
  badge?: ReactNode
  backLabel: string
  onBack: () => void
  /** Offered when given (the person may restore). */
  restoreLabel?: string
  onRestore?: () => void
  /**
   * Set when this version cannot be restored: Restore stays, `aria-disabled` and focusable, and this text is
   * shown under the message and linked as its description. `onRestore` is not called.
   */
  restoreBlockedReason?: string
  /** Restore opens a confirmation dialog (default true): adds `aria-haspopup="dialog"`. */
  restoreOpensDialog?: boolean
  restoreRef?: Ref<HTMLButtonElement>
  /** `data-testid`s: the banner is `testId`, `-heading`, `-back` and `-restore` follow. */
  testId?: string
}

/**
 * VersionBanner — what heads a page while an older version of a record is open: an info Banner (`live="off"`,
 * static: the person arrived here by an action, and the heading's focus tells them where they are) with the
 * heading (focused on mount — remount it, with a `key`, per version), the app's sentence, **Back** and, for a
 * person who may restore, **Restore**. Presentational: the app fetches who/when and runs the restore.
 */
export function VersionBanner({
  title,
  headingLevel = 3,
  children,
  badge,
  backLabel,
  onBack,
  restoreLabel,
  onRestore,
  restoreBlockedReason,
  restoreOpensDialog = true,
  restoreRef,
  testId,
}: VersionBannerProps) {
  const headingRef = useFocusOnMount<HTMLSpanElement>()
  const reasonId = useId()
  const offersRestore = restoreLabel !== undefined && onRestore !== undefined
  const blocked = offersRestore && restoreBlockedReason !== undefined
  return (
    <Banner
      tone="info"
      live="off"
      data-testid={testId}
      title={
        <span
          ref={headingRef}
          role="heading"
          aria-level={headingLevel}
          tabIndex={-1}
          data-testid={testId ? `${testId}-heading` : undefined}
        >
          {title}
        </span>
      }
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onBack} data-testid={testId ? `${testId}-back` : undefined}>
            {backLabel}
          </Button>
          {offersRestore && (
            <Button
              ref={restoreRef}
              size="sm"
              variant="primary"
              aria-haspopup={restoreOpensDialog && !blocked ? 'dialog' : undefined}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={() => {
                if (!blocked) onRestore()
              }}
              data-testid={testId ? `${testId}-restore` : undefined}
            >
              {restoreLabel}
            </Button>
          )}
        </>
      }
    >
      <span className="flex flex-wrap items-center gap-2">
        <span>{children}</span>
        {badge}
      </span>
      {blocked && (
        <p id={reasonId} className="m-0 mt-1 text-sm">
          {restoreBlockedReason}
        </p>
      )}
    </Banner>
  )
}

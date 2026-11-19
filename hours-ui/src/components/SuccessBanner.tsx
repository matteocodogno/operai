import { useMemo } from 'react'
import { Banner } from '@operai/ui'
import { strings } from '../strings'

/**
 * SuccessBanner — the confirmation of the person's own action (INC-19, design-system.md § Feedback):
 * a compact `Banner tone="success"` (`role="status"`, polite) shown where the person acted,
 * dismissed after about 3 seconds or with ×. Never the shell's ToastHost, which is reserved for
 * notifications that arrive from elsewhere. A thin adapter over the library `Banner`, like the same
 * file in admin-ui.
 *
 * `testId` sits on the message itself, so `textContent` is exactly the message (the × button's text
 * stays out of it); the banner is `${testId}-banner` and its × `${testId}-dismiss`.
 *
 * `tone="warning"` (no auto-dismiss) is for an action that succeeded with a caveat the person must
 * not miss.
 */
export type SuccessBannerProps = {
  /** The confirmation; nothing renders while null/empty. */
  message: string | null
  onDismiss: () => void
  testId: string
  tone?: 'success' | 'warning'
  className?: string
}

export default function SuccessBanner({ message, onDismiss, testId, tone = 'success', className }: SuccessBannerProps) {
  // A stable child keeps Banner's auto-dismiss timer from restarting on every parent render.
  const content = useMemo(() => <span data-testid={testId}>{message}</span>, [message, testId])

  if (!message) return null

  return (
    <Banner
      tone={tone}
      compact
      autoDismiss={tone === 'success'}
      onDismiss={onDismiss}
      dismissLabel={strings.common.dismiss}
      dismissTestId={`${testId}-dismiss`}
      data-testid={`${testId}-banner`}
      className={className}
    >
      {content}
    </Banner>
  )
}

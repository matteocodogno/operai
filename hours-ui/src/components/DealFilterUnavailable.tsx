import type { Ref } from 'react'
import { Banner, Button } from '@operai/ui'
import { strings } from '../strings'

export type DealFilterUnavailableProps = {
  /** Ask again: the page re-asks every read of the view. */
  onRetry: () => void
  /** Drop the deal filter: the view then loads normally without it. */
  onClear: () => void
  /** For the page to focus after a retry that failed (the Retry button that had focus is gone). */
  ref?: Ref<HTMLDivElement>
}

/**
 * DealFilterUnavailable — the ONE banner that replaces Totals and Entries while a deal filter is set and
 * Meetings cannot say which meetings are linked to that deal (specs/029-time-tracking T25; AC-4.11, D45;
 * design S1 "Deal filter unavailable"; Everyone's hours, T29, shows it with the same words). A list or a
 * total drawn without those meetings would be incomplete and look complete, so nothing is drawn until the
 * link can be read — never the empty state, never "0 min", never rows left over from another filter.
 *
 * A warning `Banner` with its default `role="alert"`, announced where it appears; it does not take focus
 * (the person is in the Filters card), but the page can, through `ref`, after a retry that failed.
 */
export default function DealFilterUnavailable({ onRetry, onClear, ref }: DealFilterUnavailableProps) {
  const t = strings.entries.dealFilterUnavailable
  return (
    <Banner
      ref={ref}
      tabIndex={-1}
      tone="warning"
      title={t.title}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      retryTestId="hours-deal-filter-unavailable-retry"
      actions={
        <Button variant="ghost" size="sm" onClick={onClear} data-testid="hours-deal-filter-unavailable-clear">
          {t.clear}
        </Button>
      }
      data-testid="hours-deal-filter-unavailable"
    >
      {t.body}
    </Banner>
  )
}

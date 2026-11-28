import type { Ref } from 'react'
import { Banner, Button } from '@operai/ui'
import { strings } from '../strings'

/** The host filter a refusal is about: the meetings linked to a deal, or to a project (specs/20261112-project-hours AC-4.8). */
export type HostFilterKind = 'deal' | 'project'

export type DealFilterUnavailableProps = {
  /** Which filter's meetings could not be read: it picks the words and the test ids, nothing else. */
  kind: HostFilterKind
  /** Ask again: the page re-asks every read of the view. */
  onRetry: () => void
  /** Drop the filter: the view then loads normally without it. */
  onClear: () => void
  /** For the page to focus after a retry that failed (the Retry button that had focus is gone). */
  ref?: Ref<HTMLDivElement>
}

/**
 * DealFilterUnavailable — the ONE banner that replaces Totals and Entries while a deal filter, or a project filter, is
 * set and Meetings cannot say which meetings are linked to that deal or project (specs/20261112-time-tracking T25;
 * AC-4.11, D45; design S1 "Deal filter unavailable"; Everyone's hours, T29, shows it with the same words; generalised
 * to the project filter by specs/20261112-project-hours T12, AC-4.8, design S4: one component, `kind` picks the
 * words). A list or a total drawn without those meetings would be incomplete and look complete, so nothing is drawn
 * until the link can be read — never the empty state, never "0 min", never rows left over from another filter.
 *
 * A warning `Banner` with its default `role="alert"`, announced where it appears; it does not take focus
 * (the person is in the Filters card), but the page can, through `ref`, after a retry that failed.
 */
export default function DealFilterUnavailable({ kind, onRetry, onClear, ref }: DealFilterUnavailableProps) {
  const t = kind === 'project' ? strings.entries.projectFilterUnavailable : strings.entries.dealFilterUnavailable
  return (
    <Banner
      ref={ref}
      tabIndex={-1}
      tone="warning"
      title={t.title}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      retryTestId={`hours-${kind}-filter-unavailable-retry`}
      actions={
        <Button variant="ghost" size="sm" onClick={onClear} data-testid={`hours-${kind}-filter-unavailable-clear`}>
          {t.clear}
        </Button>
      }
      data-testid={`hours-${kind}-filter-unavailable`}
    >
      {t.body}
    </Banner>
  )
}

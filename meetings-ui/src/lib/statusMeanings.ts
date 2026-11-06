/**
 * statusMeanings — the ONE place meetings-ui maps its domain states to the suite's status
 * dictionary (`STATUS` in @operai/ui, INC-23; design.md Conventions › Statuses). The meaning
 * picks the badge's tone and icon; the label is this app's (`strings.common.status`).
 *
 * A flag that is not a status ("Edited", "AI-generated", "Based on an earlier version", role,
 * source, language) is a plain `Badge`, never a `StatusBadge`.
 */
import type { StatusMeaning } from '@operai/ui'
import type { DerivedStatus, SummaryStatus } from './types'

export const MEETING_STATUS_MEANING: Record<DerivedStatus, StatusMeaning> = {
  draft: 'draft',
  recording: 'pending',
  // Recording stopped without being saved: someone has to decide what to do with what was captured.
  interrupted: 'attention',
  processing: 'pending',
  ready: 'settled',
  failed: 'failed',
}

export const SUMMARY_STATUS_MEANING: Record<SummaryStatus, StatusMeaning> = {
  generating: 'pending',
  ready: 'settled',
  failed: 'failed',
}

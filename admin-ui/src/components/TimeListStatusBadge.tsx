import { StatusBadge } from '@operai/ui'
import { TIME_LIST_STATUS_MEANING } from '../lib/statusMeaning'
import type { TimeListItemStatus } from '../lib/statusMeaning'
import { strings } from '../strings'

/**
 * TimeListStatusBadge — whether a category or work type is still offered (T32, specs/029-time-tracking,
 * design.md S5): Active, or Retired, as the library `StatusBadge` (INC-23) with the meaning from
 * `lib/statusMeaning.ts` (Active → `active`, Retired → `voided`) and the label from
 * `strings.badges.timeListStatus`. The label is text, so colour is never the only signal.
 */
export type TimeListStatusBadgeProps = {
  /** The item's `retired` flag, as the API sends it. */
  retired: boolean
}

export default function TimeListStatusBadge({ retired }: TimeListStatusBadgeProps) {
  const status: TimeListItemStatus = retired ? 'retired' : 'active'
  return (
    <StatusBadge status={TIME_LIST_STATUS_MEANING[status]} data-testid="time-list-status-badge">
      {strings.badges.timeListStatus[status]}
    </StatusBadge>
  )
}

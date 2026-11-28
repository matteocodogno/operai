import { Badge } from '@operai/ui'
import { strings } from '../strings'

/**
 * The "From meeting" mark of one entry (specs/20261112-meeting-hours AC-2.3, AC-4.3; design S1, S2): its tone, copy and test id
 * in one place for `EntryRow` and `EntriesTable`. It draws unconditionally: whether to draw it is `showsFromMeetingMark`
 * (src/lib/fromMeetingMark.ts), and where is each caller's layout. hours-specific, so not in @operai/ui.
 */
export default function FromMeetingBadge({ entryId }: { entryId: string }) {
  return (
    <Badge tone="accent" data-testid={`hours-entry-${entryId}-from-meeting`}>
      {strings.entries.fromMeeting}
    </Badge>
  )
}

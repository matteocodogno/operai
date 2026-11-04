import type { HostInfo, Meeting } from '../../lib/types'

export type SummariesPanelProps = {
  meeting: Meeting
  /** The host's registration, for the "Recommended for <entity>" template group (AC-8.5); null for a standalone meeting. */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T71 builds the summaries tab (S3b). */
export default function SummariesPanel(props: SummariesPanelProps) {
  void props
  return null
}

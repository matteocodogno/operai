import type { Meeting } from '../../lib/types'

export type RecordingPanelProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T64 builds the capture options and recording panel (S5, F4). */
export default function RecordingPanel(props: RecordingPanelProps) {
  void props
  return null
}

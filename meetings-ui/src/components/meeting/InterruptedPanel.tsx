import type { Meeting } from '../../lib/types'

export type InterruptedPanelProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T65 builds the interrupted panel (F5). */
export default function InterruptedPanel(props: InterruptedPanelProps) {
  void props
  return null
}

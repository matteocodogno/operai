import type { Meeting } from '../../lib/types'

export type AskPanelProps = {
  meeting: Meeting
  /** A source was activated: the page switches to the Transcript tab and focuses that segment (F12). */
  onOpenSource: (segmentId: string) => void
}

/** Placeholder (specs/021-meetings T53): T73 builds the Ask tab (S3b). */
export default function AskPanel(props: AskPanelProps) {
  void props
  return null
}

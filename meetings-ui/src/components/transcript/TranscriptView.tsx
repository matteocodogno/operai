import type { Meeting } from '../../lib/types'

export type TranscriptViewProps = {
  meeting: Meeting
  /** The cited segment to highlight and focus (from the Ask tab), or null. */
  focusSegmentId: string | null
  /** Returns focus to the citation that opened this segment; null when nothing opened it (F12). */
  onBackToAnswer: (() => void) | null
}

/** Placeholder (specs/021-meetings T53): T68 builds the transcript tab (S3b). */
export default function TranscriptView(props: TranscriptViewProps) {
  void props
  return null
}

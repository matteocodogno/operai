import type { Meeting } from '../../lib/types'

export type UploadCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T66 builds the upload card (F6). */
export default function UploadCard(props: UploadCardProps) {
  void props
  return null
}

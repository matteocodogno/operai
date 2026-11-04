import type { Meeting } from '../../lib/types'

export type TextCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T67 builds the text card (F7). */
export default function TextCard(props: TextCardProps) {
  void props
  return null
}

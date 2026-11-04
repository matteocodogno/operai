import type { Meeting } from '../../lib/types'

export type ConsentCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T61 builds the consent card (F3). */
export default function ConsentCard(props: ConsentCardProps) {
  void props
  return null
}

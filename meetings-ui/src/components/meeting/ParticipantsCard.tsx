import type { HostInfo, Meeting } from '../../lib/types'

export type ParticipantsCardProps = {
  meeting: Meeting
  /** The host's registration, for the host-visible checkbox and its hint (plan G6); null for a standalone meeting. */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T60 builds the participants card, which owns its Edit participants dialog. */
export default function ParticipantsCard(props: ParticipantsCardProps) {
  void props
  return null
}

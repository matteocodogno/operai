import type { Meeting } from '../../lib/types'

export type EditParticipantsDialogProps = {
  meeting: Meeting
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T60 builds the Edit participants dialog (S4). */
export default function EditParticipantsDialog(props: EditParticipantsDialogProps) {
  void props
  return null
}

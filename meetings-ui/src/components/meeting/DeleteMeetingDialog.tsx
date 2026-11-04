import type { Meeting } from '../../lib/types'

export type DeleteMeetingDialogProps = {
  meeting: Meeting
  onClose: () => void
  /** The meeting is gone: the page leaves it for the list. */
  onDeleted: () => void
}

/** Placeholder (specs/021-meetings T53): T75 builds the Delete meeting dialog (S3c). */
export default function DeleteMeetingDialog(props: DeleteMeetingDialogProps) {
  void props
  return null
}

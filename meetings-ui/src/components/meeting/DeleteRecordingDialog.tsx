import type { Meeting } from '../../lib/types'

export type DeleteRecordingDialogProps = {
  meeting: Meeting
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T70 builds the Delete recording dialog (S3c). */
export default function DeleteRecordingDialog(props: DeleteRecordingDialogProps) {
  void props
  return null
}

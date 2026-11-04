import type { HostInfo, Meeting } from '../../lib/types'

export type EditDetailsDialogProps = {
  meeting: Meeting
  /** The host's registration, for the visibility hint (plan G6); null for a standalone meeting. */
  hostInfo: HostInfo | null
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T58 builds the Edit details dialog (S3c). */
export default function EditDetailsDialog(props: EditDetailsDialogProps) {
  void props
  return null
}

import type { HostInfo, Meeting } from '../../lib/types'

export type HostNoticeBannerProps = {
  meeting: Meeting
  /** The host's registration: its `labels.<lang>.noticeFailed` sentence is the banner text (plan G7). */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

/** Placeholder (specs/021-meetings T53): T59 builds the host-notice failure banner (F11). */
export default function HostNoticeBanner(props: HostNoticeBannerProps) {
  void props
  return null
}

import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import type { AssetView } from '../lib/types'

/**
 * HistoryTimeline — STUB created by T32 (specs/015-hardware-inventory); T36
 * fills the body and never edits `AssetDetailPage.tsx`.
 *
 * Final props (decided by T32): rendered for either capability, for disposed
 * assets too. It fetches `GET /assets/{id}/history` itself and keeps its own
 * loading / error / empty states, so a failure stays local to the section.
 *   - `asset`          only `asset.id` is needed.
 *   - `capabilities`   `{ canManageAssets, canManageLedger }`.
 *   - `revision`       a number the page increments every time the asset
 *                      changes (a region write, an edit, a reload): reload the
 *                      events whenever it changes.
 */
export type HistoryTimelineProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  revision: number
}

export default function HistoryTimeline(props: HistoryTimelineProps) {
  void props
  return null
}

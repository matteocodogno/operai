import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import type { AssetView } from '../lib/types'

/**
 * AssetActions — STUB created by T32 (specs/015-hardware-inventory); T33 fills
 * the body and never edits `AssetDetailPage.tsx`.
 *
 * Final props (decided by T32, the page passes exactly these):
 *   - `asset`          the loaded asset. Never rendered for a disposed asset.
 *   - `capabilities`   `{ canManageAssets, canManageLedger }`. The page renders
 *                      this region for ANY viewer of a non-disposed asset,
 *                      because the pending-assignment and holder-deleted
 *                      callouts are read-only for an accountant (design § T2:
 *                      "M or L, button M only"); the action group, Assign,
 *                      Cancel assignment and Record return are gated on
 *                      `canManageAssets` INSIDE this component and absent from
 *                      the DOM otherwise (AC-9.3).
 *   - `onChanged(updated)`  after a write: pass the `AssetView` the server
 *                      returned to replace the page's asset, or `null` to make
 *                      the page reload it in place (a conflict such as
 *                      `invalid_transition` / `assignment_pending`).
 *   - `announce(message)`   fills the page's one polite `role="status"` line.
 *   - `focusHeading()`      moves focus to the page heading (for an action
 *                      whose trigger disappears).
 *
 * The page owns the "Edit details" button (and "Mark as verified"); this
 * component owns every status action of design F5 and the two callouts.
 */
export type AssetActionsProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
}

export default function AssetActions(props: AssetActionsProps) {
  void props
  return null
}

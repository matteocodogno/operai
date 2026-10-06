import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import type { AssetView } from '../lib/types'

/**
 * LedgerBlock — STUB created by T32 (specs/015-hardware-inventory); T34 fills
 * the body and never edits `AssetDetailPage.tsx`.
 *
 * Final props (decided by T32): the page renders this region ONLY when
 * `capabilities.canManageLedger` (so the block can assume it), and for a
 * disposed asset too (it shows the disposal and no Dispose button).
 *   - `asset`          carries `ledger` (book value, rule, schedule) for a
 *                      `ledger:manage` caller; treat `ledger === undefined` as
 *                      "not available" rather than crashing.
 *   - `capabilities`   always `canManageLedger: true` here; passed for symmetry.
 *   - `onChanged(updated)`  `AssetView` from a write replaces the page's asset;
 *                      `null` reloads it in place.
 *   - `announce(message)`   the page's polite status line.
 *   - `focusHeading()`      focus the page heading (after Dispose the button is gone).
 */
export type LedgerBlockProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
}

export default function LedgerBlock(props: LedgerBlockProps) {
  void props
  return null
}

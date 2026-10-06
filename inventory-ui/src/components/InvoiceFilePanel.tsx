import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import type { AssetView } from '../lib/types'

/**
 * InvoiceFilePanel — STUB created by T32 (specs/015-hardware-inventory); T35
 * fills the body and never edits `AssetDetailPage.tsx`.
 *
 * Final props (decided by T32): rendered for either capability, including for a
 * disposed asset (read-only: derive it from `asset.status === 'disposed'`).
 *   - `asset`          reference (`invoiceRef`), linked file (`invoiceFile`),
 *                      entity (the upload is scoped to it) and status.
 *   - `capabilities`   `{ canManageAssets, canManageLedger }`; both roles may
 *                      upload and link (AC-10.4).
 *   - `onChanged(updated)`  `null` after a link (the page reloads the asset in
 *                      place so `invoiceFile` is fresh); an `AssetView` replaces it.
 *   - `announce(message)`   the page's polite status line.
 *   - `focusHeading()`      focus the page heading.
 */
export type InvoiceFilePanelProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
}

export default function InvoiceFilePanel(props: InvoiceFilePanelProps) {
  void props
  return null
}

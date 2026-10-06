import { sendJson } from './api'
import type { AssetView, DisposeInput } from './types'

/** `POST /assets/{id}/dispose` — `ledger:manage`. Disposal is irreversible. */
export const disposeAsset = (assetId: string, input: DisposeInput): Promise<AssetView> =>
  sendJson<AssetView>(`/assets/${encodeURIComponent(assetId)}/dispose`, 'POST', input)

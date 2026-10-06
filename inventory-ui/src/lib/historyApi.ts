import { getJson } from './api'
import type { HistoryEvent } from './types'

/** `GET /assets/{id}/history` — either capability; 404 for an unknown or out-of-scope asset. */
export const getAssetHistory = (assetId: string, init?: RequestInit): Promise<{ events: HistoryEvent[] }> =>
  getJson<{ events: HistoryEvent[] }>(`/assets/${encodeURIComponent(assetId)}/history`, init)

import { getJson, sendJson } from './api'
import type { AssetListFilters, AssetListPage, AssetPatch, AssetView, RegisterAssetsInput } from './types'

/**
 * `/assets` routes of plan.md § API contracts (`asset:manage` unless stated;
 * the three reads accept either capability). Every status transition is a
 * body-less POST answering the updated `AssetView`; the documented conflicts
 * (`invalid_transition`, `assignment_pending`, `asset_disposed`,
 * `fiscal_year_closed`, `serial_conflict`, ...) arrive as `ApiError`s that
 * `toInventoryError` (./types) narrows.
 */

const assetPath = (id: string, suffix = '') => `/assets/${encodeURIComponent(id)}${suffix}`

/** Query string in a fixed order; unset, false (`toVerify`) and empty filters are left out. */
const toQuery = (filters: AssetListFilters): string => {
  const params = new URLSearchParams()
  if (filters.entity) params.set('entity', filters.entity)
  if (filters.status) params.set('status', filters.status)
  if (filters.category) params.set('category', filters.category)
  if (filters.holderUserId) params.set('holderUserId', filters.holderUserId)
  if (filters.toVerify) params.set('toVerify', 'true')
  if (filters.invoiceRef) params.set('invoiceRef', filters.invoiceRef)
  if (filters.q) params.set('q', filters.q)
  if (filters.cursor) params.set('cursor', filters.cursor)
  if (filters.limit !== undefined) params.set('limit', String(filters.limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Newest purchase first; `nextCursor` is null on the last page. */
export const listAssets = (filters: AssetListFilters = {}, init?: RequestInit): Promise<AssetListPage> =>
  getJson<AssetListPage>(`/assets${toQuery(filters)}`, init)

export const getAsset = (id: string, init?: RequestInit): Promise<AssetView> => getJson<AssetView>(assetPath(id), init)

export const registerAssets = (input: RegisterAssetsInput): Promise<{ assets: AssetView[] }> =>
  sendJson<{ assets: AssetView[] }>('/assets', 'POST', input)

export const updateAsset = (id: string, patch: AssetPatch): Promise<AssetView> =>
  sendJson<AssetView>(assetPath(id), 'PATCH', patch)

export const receiveAsset = (id: string): Promise<AssetView> => sendJson<AssetView>(assetPath(id, '/receive'), 'POST')
export const returnAsset = (id: string): Promise<AssetView> => sendJson<AssetView>(assetPath(id, '/return'), 'POST')
export const startRepair = (id: string): Promise<AssetView> => sendJson<AssetView>(assetPath(id, '/repair'), 'POST')
export const finishRepair = (id: string): Promise<AssetView> =>
  sendJson<AssetView>(assetPath(id, '/repair-done'), 'POST')
export const markLost = (id: string): Promise<AssetView> => sendJson<AssetView>(assetPath(id, '/lost'), 'POST')
export const markFound = (id: string): Promise<AssetView> => sendJson<AssetView>(assetPath(id, '/found'), 'POST')

import { sendJson } from './api'
import type { AssetView } from './types'

/** Manager side of assignments (the employee side is `meApi`). */

export const createAssignment = (assetId: string, assigneeUserId: string): Promise<AssetView> =>
  sendJson<AssetView>(`/assets/${encodeURIComponent(assetId)}/assignments`, 'POST', { assigneeUserId })

/** 409 `assignment_not_pending` when someone else already confirmed, declined or cancelled it. */
export const cancelAssignment = (assignmentId: string): Promise<AssetView> =>
  sendJson<AssetView>(`/assignments/${encodeURIComponent(assignmentId)}/cancel`, 'POST')

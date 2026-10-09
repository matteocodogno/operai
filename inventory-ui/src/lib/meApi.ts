import { getJson, sendJson } from './api'
import type { MyDevice, MyDevicesResponse } from './types'

/**
 * The ungated `/me/*` routes behind the devices view (US-4): JWT only, no
 * catalog permission, always scoped to the caller's `sub` server-side. Nothing
 * here asks for a capability or for `/scope` (ADR-0045).
 */

const assignmentPath = (id: string, action: 'confirm' | 'decline') =>
  `/me/assignments/${encodeURIComponent(id)}/${action}`

export const getMyDevices = (init?: RequestInit): Promise<MyDevicesResponse> =>
  getJson<MyDevicesResponse>('/me/devices', init)

/** 409 `assignment_not_pending` and 404 both mean "no longer open". */
export const confirmAssignment = (assignmentId: string): Promise<{ device: MyDevice }> =>
  sendJson<{ device: MyDevice }>(assignmentPath(assignmentId, 'confirm'), 'POST')

export const declineAssignment = (assignmentId: string): Promise<void> =>
  sendJson<void>(assignmentPath(assignmentId, 'decline'), 'POST')

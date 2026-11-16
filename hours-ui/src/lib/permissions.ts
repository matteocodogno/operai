/**
 * permissions — what hours-ui reads from the shell's permissions, for UX only (the server is the gate,
 * ADR 20261108-estimai-oversight-permission-amends-0036; specs/20261112-time-tracking design § Frame of `hours-ui`).
 *
 * Two things vary per person — the `hours` catalog has no `access` resource, because the screens are
 * ungated (AC-5.1, ADR 20261112-hours-ui-ungated-remote): whether they hold `time-entry:read-all`, which
 * decides whether the Everyone's hours tab exists, and whether they hold `time-list:manage`, which decides
 * whether the Settings tab (the time lists, T43, D51) does. The two are independent. `/authz/me` lists
 * every effective permission, so a catalog without `access` is included.
 *
 * `usePermissions()` has no "loaded" flag: until `GET /authz/me` answers it is the shell's empty
 * result (epoch 0, nothing else), the same result a failed fetch resolves to. So `canReadAll` is false
 * until the answer says otherwise (it fails closed, and the tab stays out of the DOM while permissions
 * resolve), and `resolved` is read from the answer itself: anything in it at all (the estimai-ui rule,
 * widened to roles, departments and permissions) shows it has arrived. A person whose answer is empty
 * in every field cannot be told from "not resolved yet"; that case can only wait, so a screen that
 * waits on `resolved` must not wait without end for the one page that needs it.
 */
import { useEffect, useState } from 'react'
import { usePermissions } from 'shell/session'
import type { PermissionsResult } from 'shell/session'

export type HoursAccess = {
  /** The permissions answer has arrived (see above). */
  resolved: boolean
  /** Holds `time-entry:read-all`: may see everyone's hours. */
  canReadAll: boolean
  /** Holds `time-list:manage`: may manage the categories and work types (the Settings tab). */
  canManageLists: boolean
}

const holds = (result: PermissionsResult, resource: string, action: string): boolean =>
  result.permissions.some((p) => p.resource === resource && p.action === action)

export const hoursAccessOf = (result: PermissionsResult): HoursAccess => ({
  resolved:
    result.epoch > 0 ||
    result.apps.length > 0 ||
    result.roles.length > 0 ||
    result.departments.length > 0 ||
    result.permissions.length > 0,
  canReadAll: holds(result, 'time-entry', 'read-all'),
  canManageLists: holds(result, 'time-list', 'manage'),
})

export const useHoursAccess = (): HoursAccess => hoursAccessOf(usePermissions())

/**
 * How long a page waits for the person's permissions before it stops waiting. `usePermissions()` has no
 * "loaded" flag, and an answer that is empty in every field (a person with no grants at all, or an
 * `/authz/me` that failed) cannot be told from one that has not come yet (see above), so a page that
 * waited on `resolved` alone would wait for ever. Past this, a person whose permissions did not say they
 * may is treated as one who may not: the denial, and nothing asked.
 */
export const PERMISSIONS_WAIT_MS = 3000

/** True once `waiting` has held for `PERMISSIONS_WAIT_MS` without a break; it stays true after that. */
export const useWaitedOut = (waiting: boolean): boolean => {
  const [waitedOut, setWaitedOut] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setWaitedOut(true), PERMISSIONS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [waiting])
  return waitedOut
}

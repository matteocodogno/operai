/**
 * permissions — what hours-ui reads from the shell's permissions, for UX only (the server is the gate,
 * ADR-0075; specs/029-time-tracking design § Frame of `hours-ui`).
 *
 * The one thing that varies per person is whether they hold `time-entry:read-all` — the `hours`
 * catalog has no `access` resource, because the screens are ungated (AC-5.1, ADR-0090) — and it decides
 * whether the Everyone's hours tab exists. `/authz/me` lists every effective permission, so a
 * catalog without `access` is included.
 *
 * `usePermissions()` has no "loaded" flag: until `GET /authz/me` answers it is the shell's empty
 * result (epoch 0, nothing else), the same result a failed fetch resolves to. So `canReadAll` is false
 * until the answer says otherwise (it fails closed, and the tab stays out of the DOM while permissions
 * resolve), and `resolved` is read from the answer itself: anything in it at all (the estimai-ui rule,
 * widened to roles, departments and permissions) shows it has arrived. A person whose answer is empty
 * in every field cannot be told from "not resolved yet"; that case can only wait, so a screen that
 * waits on `resolved` must not wait without end for the one page that needs it.
 */
import { usePermissions } from 'shell/session'
import type { PermissionsResult } from 'shell/session'

export type HoursAccess = {
  /** The permissions answer has arrived (see above). */
  resolved: boolean
  /** Holds `time-entry:read-all`: may see everyone's hours. */
  canReadAll: boolean
}

export const hoursAccessOf = (result: PermissionsResult): HoursAccess => ({
  resolved:
    result.epoch > 0 ||
    result.apps.length > 0 ||
    result.roles.length > 0 ||
    result.departments.length > 0 ||
    result.permissions.length > 0,
  canReadAll: result.permissions.some((p) => p.resource === 'time-entry' && p.action === 'read-all'),
})

export const useHoursAccess = (): HoursAccess => hoursAccessOf(usePermissions())

// Ambient module declarations for the shell modules crm-ui consumes as a
// remote (specs/20261101-crm, specs/20261104-meetings). Module Federation resolves
// `shell/session`, `shell/extensions` and `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
// `dts` option is off in vite.config.ts so this remote builds without a live
// shell. Keep in sync by hand with shell/src/lib/session.ts.

declare module 'shell/session' {
  export interface ShellSessionUser {
    id?: string
    name?: string | null
    email?: string | null
    image?: string | null
  }

  export interface ShellSessionState {
    data: { user?: ShellSessionUser } | null
    isPending?: boolean
    error?: unknown
  }

  export const useSession: () => ShellSessionState
  export const apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  // crm-api for every call to this tool's backend; `auth` for the user
  // directory behind the owner/assignee picker (ADR 20261006-user-directory-endpoint-capability-gated, ADR 20261101-user-directory-gate-widened-to-deal-manage).
  export const getCrmApiBaseUrl: () => string
  export const getAuthBaseUrl: () => string
  // activities-api for the activity and task routes (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host); its origin is trusted by apiFetch.
  export const getActivitiesApiBaseUrl: () => string

  // Permission resolution (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims), used for UX gating only.
  export interface Permission {
    resource: string
    action: string
    conditions?: unknown
  }

  export interface PermissionsResult {
    epoch: number
    apps: string[]
    roles: string[]
    departments: string[]
    permissions: Permission[]
  }

  export const usePermissions: () => PermissionsResult
}

// The host-extension seam (specs/20261104-meetings, ADR 20261104-host-extension-federated-panel-through-the-shell): a federated panel the
// shell loads on behalf of a host, raced against a timeout, with an error
// boundary; a failure of any kind renders `fallback`. Keep in sync by hand with
// shell/src/lib/extensions.tsx. crm-ui imports it DYNAMICALLY and treats a
// missing module or export as "unavailable" (a shell that predates the expose).
declare module 'shell/extensions' {
  import type { JSX, ReactNode } from 'react'

  export interface ExtensionProps {
    'meetings.hostMeetings': { hostApp: string; entityType: string; entityId: string }
    // Record hours in place (specs/20261116-record-hours-in-place, ADR 20261116-record-hours-widget-through-the-host-extension-seam):
    // hours-ui's own widget, plain strings in and nothing back. `on: 'none'` is other work (a CRM task about a company
    // with no deal); `targetId`/`targetName`/`activityId` are then ''. `activityName` names the task when there is one
    // (and, for `on: 'none'`, only the button, never sent). `placement`: the page header's button, or a task row's.
    'hours.recordHours': {
      on: 'project' | 'deal' | 'none'
      targetId: string
      targetName: string
      activityId: string
      activityName: string
      placement: 'page' | 'row'
    }
  }

  export function HostExtension<K extends keyof ExtensionProps>(props: {
    name: K
    props: ExtensionProps[K]
    fallback: ReactNode
    loading?: ReactNode
  }): JSX.Element
}

declare module 'shell/tokens.css' {
  // Side-effect-only CSS module (the shared Operai tokens) — no exports.
}

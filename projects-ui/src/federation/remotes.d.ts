// Ambient module declarations for the shell modules projects-ui consumes as a
// remote (specs/20261103-projects, specs/20261116-record-hours-in-place). Module Federation resolves
// `shell/session`, `shell/extensions` and `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
// `dts` option is off in vite.config.ts so this remote builds without a live
// shell. Keep in sync by hand with shell/src/lib/session.ts (T15 adds
// `getProjectsApiBaseUrl` there, reading VITE_PROJECTS_API_URL).

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

  // projects-api for every call to this tool's backend; `auth` for the user
  // directory behind the project manager and team pickers (ADR 20261101-user-directory-gate-widened-to-deal-manage, ADR 20261101-app-access-check-by-user-id-and-directory-app-filter).
  export const getProjectsApiBaseUrl: () => string
  export const getAuthBaseUrl: () => string
  // activities-api for the project Tasks card and My tasks (specs/20261110-activities, T15).
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

// The host-extension seam (specs/20261116-record-hours-in-place, ADR 20261116-record-hours-widget-through-the-host-extension-seam,
// ADR 20261104-host-extension-federated-panel-through-the-shell): a federated widget the shell loads on behalf of a host, raced
// against a timeout, with an error boundary; a failure of any kind renders `fallback`. projects-ui's first use of
// it, so it declares only the one extension it embeds. Keep in sync by hand with shell/src/lib/extensions.tsx
// (`ExtensionProps['hours.recordHours']`). projects-ui imports it DYNAMICALLY and treats a missing module or
// export as "unavailable" (a shell that predates the expose).
declare module 'shell/extensions' {
  import type { JSX, ReactNode } from 'react'

  export interface ExtensionProps {
    'hours.recordHours': {
      /** What the hours are recorded on; `none` is other work (a task with no project or deal). */
      on: 'project' | 'deal' | 'none'
      /** The project or deal id; '' when `on` is `none`. */
      targetId: string
      /** Its name as the host shows it; '' when the host cannot name it, or `on` is `none`. */
      targetName: string
      /** The task's id when recorded from a task row on a project or a deal; else ''. */
      activityId: string
      /** The task's subject; '' when there is no task. With `on: 'none'` it only names the button, never sent. */
      activityName: string
      /** The page header's button, or a task row's smaller one. */
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

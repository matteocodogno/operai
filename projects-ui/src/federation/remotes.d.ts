// Ambient module declarations for the shell modules projects-ui consumes as a
// remote (specs/025-projects). Module Federation resolves `shell/session` and
// `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
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
  // directory behind the project manager and team pickers (ADR-0053, ADR-0055).
  export const getProjectsApiBaseUrl: () => string
  export const getAuthBaseUrl: () => string

  // Permission resolution (ADR-0007), used for UX gating only.
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

declare module 'shell/tokens.css' {
  // Side-effect-only CSS module (the shared Operai tokens) — no exports.
}

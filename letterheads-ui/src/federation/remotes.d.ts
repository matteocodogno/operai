// Ambient module declarations for the shell modules letterheads-ui consumes as a
// remote (specs/20261116-letterhead-service). Module Federation resolves `shell/session` and
// `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
// `dts` option is off in vite.config.ts so this remote builds without a live
// shell. Keep in sync by hand with shell/src/lib/session.ts (`getLetterheadsApiBaseUrl`
// reads VITE_LETTERHEADS_API_URL there).

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

  // letterhead-api, for every call of this tool's backend (person routes, `/v1/…`).
  export const getLetterheadsApiBaseUrl: () => string

  // The auth service's base URL (shell/src/lib/session.ts `getAuthBaseUrl`), for the registry's `/legal-entities/manageable`.
  export const getAuthBaseUrl: () => string

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

declare module 'shell/tokens.css' {
  // Side-effect-only CSS module (the shared Operai tokens) — no exports.
}

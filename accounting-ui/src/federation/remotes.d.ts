// Ambient module declarations for the shell modules accounting-ui consumes as a
// remote (specs/20261119-accounting). Module Federation resolves `shell/session` and
// `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
// `dts` option is off in vite.config.ts so this remote builds without a live
// shell. Keep in sync by hand with shell/src/lib/session.ts (`getAccountingApiBaseUrl`
// reads VITE_ACCOUNTING_API_URL there).

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

  // accounting-api, for every call of this tool's backend (person routes, `/v1/…`).
  export const getAccountingApiBaseUrl: () => string

  // Permission resolution (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims). accounting-ui does NOT use it for
  // write controls (design UX-4: `canManage` comes from `GET /v1/me`, per entity); declared for completeness.
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

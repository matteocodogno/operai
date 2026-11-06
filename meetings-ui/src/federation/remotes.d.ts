// Ambient module declarations for the shell modules meetings-ui consumes as a
// remote (specs/021-meetings). Module Federation resolves `shell/session` and
// `shell/tokens.css` at runtime through a virtual module tsc cannot see; the
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

  // meetings-api for every call to this tool's backend; `auth` for the user
  // directory behind the participant picker (ADR-0047, ADR-0066).
  export const getMeetingsApiBaseUrl: () => string
  export const getAuthBaseUrl: () => string

  // Cross-remote navigation through the shell's one router (ADR-0006).
  export const navigateSuite: (to: string) => void

  // Navigation blocker (AC-2.10, plan § Browser capture): while `shouldBlock()` is true an
  // in-app navigation asks for confirmation with `message`. Returns the unregister function.
  // A shell that predates this export does not provide it, so callers feature-detect.
  export const registerNavigationBlocker: (shouldBlock: () => boolean, message: string) => () => void

  // Permission resolution (ADR-0007), used for UX hints only (plan G5).
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

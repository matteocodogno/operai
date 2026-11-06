// Ambient module declarations for the shell modules crm-ui consumes as a
// remote (specs/017-crm, specs/021-meetings). Module Federation resolves
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
  // directory behind the owner/assignee picker (ADR-0047, ADR-0053).
  export const getCrmApiBaseUrl: () => string
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

// The host-extension seam (specs/021-meetings, ADR-0060): a federated panel the
// shell loads on behalf of a host, raced against a timeout, with an error
// boundary; a failure of any kind renders `fallback`. Keep in sync by hand with
// shell/src/lib/extensions.tsx. crm-ui imports it DYNAMICALLY and treats a
// missing module or export as "unavailable" (a shell that predates the expose).
declare module 'shell/extensions' {
  import type { JSX, ReactNode } from 'react'

  export interface ExtensionProps {
    'meetings.hostMeetings': { hostApp: string; entityType: string; entityId: string }
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

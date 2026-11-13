// Ambient module declarations for the shell modules hours-ui consumes as a
// remote (specs/029-time-tracking, plan § Components `hours-ui`). Module Federation
// resolves `shell/session` and `shell/tokens.css` at runtime through a virtual
// module tsc cannot see; the `dts` option is off in vite.config.ts so this remote
// builds without a live shell. Keep in sync by hand with shell/src/lib/session.ts.

declare module 'shell/session' {
  export const apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  // hours-api for every call to this tool's backend (the shell's trusted origin, T21).
  export const getHoursApiBaseUrl: () => string

  // The owners the entry dialog and the filters read as the person (plan § Components
  // `hours-ui`): projects-api and crm-api for the project and deal pickers, meetings-api for
  // the meeting picker, activities-api for the activity field. All four origins are already
  // trusted by `apiFetch`.
  export const getProjectsApiBaseUrl: () => string
  export const getCrmApiBaseUrl: () => string
  export const getMeetingsApiBaseUrl: () => string
  export const getActivitiesApiBaseUrl: () => string

  // Permission resolution (ADR-0007), used for UX gating only (the Everyone's hours tab):
  // the server is the gate (ADR-0075).
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

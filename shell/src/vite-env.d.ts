/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts, T6, specs/20260709-suite-shell).
// Absent under vitest, where src/lib/appInfo.ts falls back to a placeholder version.
declare const __APP_VERSION__: string

// Build-time variables read through `import.meta.env`. Only those that are OPTIONAL by
// design are typed here; the rest are read with an `as string` cast at their call site.
interface ImportMetaEnv {
  /**
   * Public origin of inventory-api (specs/20261006-hardware-inventory, T41/T43), e.g.
   * `https://inventory-api.operai.welld.io`. Optional: when unset, `getTrustedOrigins()`
   * does NOT add an inventory origin, so `apiFetch` sends no Bearer JWT there and
   * `getInventoryApiBaseUrl()` returns `undefined` at runtime. Set it on the shell
   * Vercel project; inventory-ui has no copy of its own (it asks the shell).
   */
  readonly VITE_INVENTORY_API_URL?: string
  /**
   * Public origin of crm-api (specs/20261101-crm), e.g. `https://crm-api.operai.welld.io`.
   * Optional, like VITE_INVENTORY_API_URL: unset → not trusted, no Bearer JWT sent.
   */
  readonly VITE_CRM_API_URL?: string
  /**
   * Public origin of meetings-api (specs/20261104-meetings, T50), e.g.
   * `https://meetings-api.operai.welld.io`. Optional, like VITE_CRM_API_URL: unset → not
   * trusted, no Bearer JWT sent; meetings-ui has no copy of its own (it asks the shell).
   */
  readonly VITE_MEETINGS_API_URL?: string
  /**
   * Public origin of projects-api (specs/20261103-projects), e.g.
   * `https://projects-api.operai.welld.io`. Optional, like VITE_CRM_API_URL: unset →
   * not trusted, no Bearer JWT sent.
   */
  readonly VITE_PROJECTS_API_URL?: string
  /**
   * Public origin of activities-api (specs/20261110-activities), e.g.
   * `https://activities-api.operai.welld.io`. Optional, like VITE_PROJECTS_API_URL: unset →
   * not trusted, no Bearer JWT sent.
   */
  readonly VITE_ACTIVITIES_API_URL?: string
  /**
   * Public origin of accounting-api (specs/20261119-accounting), e.g.
   * `https://accounting-api.operai.welld.io`. Optional, like VITE_PROJECTS_API_URL: unset →
   * not trusted, no Bearer JWT sent; accounting-ui has no copy of its own (it asks the shell).
   */
  readonly VITE_ACCOUNTING_API_URL?: string
  /**
   * Public origin of hours-api (specs/029-time-tracking), e.g.
   * `https://hours-api.operai.welld.io`. Optional, like VITE_ACTIVITIES_API_URL: unset →
   * not trusted, no Bearer JWT sent; hours-ui and admin-ui have no copy of their own (they ask the shell).
   */
  readonly VITE_HOURS_API_URL?: string
}

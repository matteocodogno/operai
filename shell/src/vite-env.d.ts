/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts, T6, specs/003-suite-shell).
// Absent under vitest, where src/lib/appInfo.ts falls back to a placeholder version.
declare const __APP_VERSION__: string

// Build-time variables read through `import.meta.env`. Only those that are OPTIONAL by
// design are typed here; the rest are read with an `as string` cast at their call site.
interface ImportMetaEnv {
  /**
   * Public origin of inventory-api (specs/015-hardware-inventory, T41/T43), e.g.
   * `https://inventory-api.operai.welld.io`. Optional: when unset, `getTrustedOrigins()`
   * does NOT add an inventory origin, so `apiFetch` sends no Bearer JWT there and
   * `getInventoryApiBaseUrl()` returns `undefined` at runtime. Set it on the shell
   * Vercel project; inventory-ui has no copy of its own (it asks the shell).
   */
  readonly VITE_INVENTORY_API_URL?: string
  /**
   * Public origin of crm-api (specs/017-crm), e.g. `https://crm-api.operai.welld.io`.
   * Optional, like VITE_INVENTORY_API_URL: unset → not trusted, no Bearer JWT sent.
   */
  readonly VITE_CRM_API_URL?: string
  /**
   * Public origin of meetings-api (specs/021-meetings, T50), e.g.
   * `https://meetings-api.operai.welld.io`. Optional, like VITE_CRM_API_URL: unset → not
   * trusted, no Bearer JWT sent; meetings-ui has no copy of its own (it asks the shell).
   */
  readonly VITE_MEETINGS_API_URL?: string
  /**
   * Public origin of projects-api (specs/021-projects), e.g.
   * `https://projects-api.operai.welld.io`. Optional, like VITE_CRM_API_URL: unset →
   * not trusted, no Bearer JWT sent.
   */
  readonly VITE_PROJECTS_API_URL?: string
}

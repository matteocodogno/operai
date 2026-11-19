/**
 * shell tool registry — the single source of truth for the suite's tool
 * id ↔ mount-path mapping (specs/20260709-suite-shell, T10, AC-3.4; also consumed
 * by Sidebar, T7, AC-3.1/AC-5.1).
 *
 * Centralized here so the tool ids/paths are declared exactly once. Before
 * this module existed, Sidebar.tsx (T7) hand-rolled its own `TOOLS` array;
 * T10 needs the SAME ids/paths for the root-landing redirect (AC-3.4) and the
 * `operai_last_tool` writer, so leaving two independent copies would risk
 * drift (e.g. Sidebar adds a tool but the redirect/writer never learns about
 * it, or the id spelling diverges). Sidebar now imports `TOOLS` from here
 * instead of defining its own.
 */

import { strings } from '../strings'

/** Known suite tool ids. Extend this union (and TOOLS below) to add a tool. */
export type ToolId =
  | 'estimai'
  | 'refund'
  | 'admin'
  | 'inventory'
  | 'crm'
  | 'meetings'
  | 'projects'
  | 'letterheads'
  | 'accounting'

export interface SuiteTool {
  id: ToolId
  /** The tool's name in the person's language (strings.tools — UI copy, INC-24). */
  label: string
  /** The tool's mount path under the shell router (matches its `/…/$` splat route). */
  to: string
}

/**
 * Flat, ordered list of suite tools (AC-3.1, AC-5.1). Add a tool here — no
 * other change is needed for it to appear in the sidebar; update the
 * `ToolId` union above too so the redirect/writer logic recognizes it.
 *
 * `admin` (specs/20260713-auth-roles-permissions, T24, AC-7.1/AC-7.2, ADR 20260709-suite-frontend-module-federation/0007):
 * every entry here is a *candidate* tool — Sidebar only renders the subset
 * present in the signed-in user's `usePermissions().apps`, so `admin` (and
 * any other entry) only appears in the nav for users actually granted that
 * app.
 */
export const TOOLS: readonly SuiteTool[] = [
  { id: 'estimai', label: strings.tools.estimai, to: '/estimai' },
  { id: 'refund', label: strings.tools.refund, to: '/refund' },
  { id: 'admin', label: strings.tools.admin, to: '/admin' },
  // specs/20261006-hardware-inventory, T42 (AC-9.6): a gated tool like the three
  // above. Its sibling screen `/devices` ("My devices") is deliberately NOT an
  // entry here — it is identity-scoped and reachable by every signed-in user
  // regardless of grants (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote), so it must never appear in the
  // permission-filtered sidebar nor be recorded as a last-used tool.
  { id: 'inventory', label: strings.tools.inventory, to: '/inventory' },
  // specs/20261101-crm: a gated tool, shown to holders of `crm:access` (ADR 20261101-crm-tool-shape-and-authorization).
  { id: 'crm', label: strings.tools.crm, to: '/crm' },
  // specs/20261104-meetings (ADR 20261104-meetings-tool-shape-visibility-by-participation): a gated tool. Its sibling `/my-meetings` is
  // deliberately NOT an entry here — identity-scoped and reachable by every
  // signed-in user (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote shape), so it never appears in the filtered sidebar
  // nor is recorded as a last-used tool.
  { id: 'meetings', label: strings.tools.meetings, to: '/meetings' },
  // specs/20261103-projects: a gated tool, shown to holders of `projects:access`. The id
  // is the auth catalog resource, which is what `/authz/me`'s `apps` carries.
  { id: 'projects', label: strings.tools.projects, to: '/projects' },
  // specs/20261116-letterhead-service (AC-8.1): a gated tool, shown to holders of `letterheads:access`. The id is the
  // auth catalog's app id, which is what `/authz/me`'s `apps` carries.
  { id: 'letterheads', label: strings.tools.letterheads, to: '/letterheads' },
  // specs/20261119-accounting (AC-8.1, design UX-14): a gated tool, last in the sidebar's main list (Letterheads sits in the
  // Settings group, so it follows Projects and comes before the pinned Admin). Its id is the auth catalog's app id, which is what
  // `/authz/me`'s `apps` carries; `apps ∋ accounting` is DERIVED there from `accounting:read` or `accounting:manage` covering at
  // least one entity (ADR 20261117-an-app-is-reachable-… amendment A6), so there is no `accounting:access` permission.
  { id: 'accounting', label: strings.tools.accounting, to: '/accounting' },
]

/**
 * Tools the sidebar groups under "Settings", pinned at the bottom above Admin instead of in the scrollable list:
 * useful, but opened rarely. Still ordinary gated tools (same route, same `apps` filter, same last-used writer); only
 * where the sidebar shows them changes.
 */
export const SETTINGS_TOOL_IDS: readonly ToolId[] = ['letterheads']

/** First-visit / invalid-storage fallback tool (AC-3.4). */
export const DEFAULT_TOOL_ID: ToolId = 'estimai'

/** localStorage key the root-landing redirect reads and every tool route writes (AC-3.4). */
export const LAST_TOOL_STORAGE_KEY = 'operai_last_tool'

/** Narrows an arbitrary value (e.g. a raw localStorage read) to a known ToolId. */
export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && TOOLS.some((tool) => tool.id === value)
}

/** Resolves a tool id to its mount path. Unknown ids fall back to the default tool. */
export function toolPath(id: ToolId): string {
  return TOOLS.find((tool) => tool.id === id)?.to ?? (TOOLS.find((tool) => tool.id === DEFAULT_TOOL_ID) as SuiteTool).to
}

/**
 * Resolves the root-landing redirect target (AC-3.4, Flow 2):
 *   - a KNOWN tool id in `operai_last_tool` → that tool's path
 *   - absent, unreadable (no localStorage / throws), or an unrecognized
 *     value (never trusted as-is — validated against the known tool set
 *     before it can influence navigation) → the default tool's path
 */
export function resolveLastToolPath(): string {
  try {
    if (typeof localStorage === 'undefined') {
      return toolPath(DEFAULT_TOOL_ID)
    }
    const stored = localStorage.getItem(LAST_TOOL_STORAGE_KEY)
    if (isToolId(stored)) {
      return toolPath(stored)
    }
  } catch {
    // Storage inaccessible (privacy mode, disabled storage, SSR, etc.) — fall
    // back to the default rather than throwing (T10 defensive requirement).
  }
  return toolPath(DEFAULT_TOOL_ID)
}

/**
 * Records the given tool as most-recently-used (Flow 3 step 4 / Flow 2 step
 * 2). Called from each tool route's `beforeLoad` (T10) so the write is
 * driven by the ROUTE becoming active — deep links and programmatic
 * navigation record it exactly like a sidebar click does, not just clicks.
 */
export function recordLastTool(id: ToolId): void {
  try {
    if (typeof localStorage === 'undefined') {
      return
    }
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, id)
  } catch {
    // Storage write failure (quota, privacy mode, etc.) — non-fatal, the
    // user just won't get the last-used redirect next time.
  }
}

/**
 * Reads the tool id most recently recorded by `recordLastTool` — i.e. the
 * tool the caller was in immediately BEFORE the navigation currently being
 * resolved (see router.tsx's `createToolAccessBeforeLoad`: `recordLastTool`
 * runs at the END of a tool route's `beforeLoad`, so while a NEW navigation's
 * `beforeLoad` is running, this key still holds the PREVIOUS tool).
 *
 * Used by the shell router's app-access guard to distinguish same-app
 * navigation (inner-route change within the tool the user is already in)
 * from an app switch, WITHOUT touching the permissions cache — a plain
 * synchronous localStorage read, unlike `resolveLastToolPath` (which also
 * applies the default-tool fallback used for the root-landing redirect; that
 * fallback is wrong here, where "no recorded tool" must mean "cannot be the
 * same app", not "fall back to EstimAI").
 *
 * Same defensive contract as `resolveLastToolPath`: absent, unreadable, or an
 * unrecognized/tampered value all resolve to `null` rather than throwing.
 */
export function readLastToolId(): ToolId | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null
    }
    const stored = localStorage.getItem(LAST_TOOL_STORAGE_KEY)
    return isToolId(stored) ? stored : null
  } catch {
    return null
  }
}

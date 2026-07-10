/**
 * shell tool registry — the single source of truth for the suite's tool
 * id ↔ mount-path mapping (specs/003-suite-shell, T10, AC-3.4; also consumed
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

/** Known suite tool ids. Extend this union (and TOOLS below) to add a tool. */
export type ToolId = 'estimai' | 'refund'

export interface SuiteTool {
  id: ToolId
  label: string
  /** The tool's mount path under the shell router (matches its `/…/$` splat route). */
  to: string
}

/**
 * Flat, ordered list of suite tools (AC-3.1, AC-5.1). Add a tool here — no
 * other change is needed for it to appear in the sidebar; update the
 * `ToolId` union above too so the redirect/writer logic recognizes it.
 */
export const TOOLS: readonly SuiteTool[] = [
  { id: 'estimai', label: 'EstimAI', to: '/estimai' },
  { id: 'refund', label: 'Refund (Rimborsi)', to: '/refund' },
]

/** First-visit / invalid-storage fallback tool (AC-3.4). */
export const DEFAULT_TOOL_ID: ToolId = 'estimai'

/** localStorage key the root-landing redirect reads and every tool route writes (AC-3.4). */
export const LAST_TOOL_STORAGE_KEY = 'operai_last_tool'

/** Narrows an arbitrary value (e.g. a raw localStorage read) to a known ToolId. */
export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && TOOLS.some(tool => tool.id === value)
}

/** Resolves a tool id to its mount path. Unknown ids fall back to the default tool. */
export function toolPath(id: ToolId): string {
  return TOOLS.find(tool => tool.id === id)?.to ?? (TOOLS.find(tool => tool.id === DEFAULT_TOOL_ID) as SuiteTool).to
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

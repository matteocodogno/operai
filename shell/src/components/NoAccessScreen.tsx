/**
 * NoAccessScreen — Screen S1, the shell's `/no-access` empty state
 * (specs/004-auth-roles-permissions, T25, design.md "Screen S1 — Shell
 * `/no-access`", AC-7.4).
 *
 * Rendered by the `/no-access` route (src/router.tsx) inside the shell's
 * existing `<main>` — it is ordinary content, not a new landmark (design.md:
 * "no new landmark"). Reached in two ways:
 *   - the root `/` redirect resolves here directly when the signed-in user's
 *     `apps` is empty (nothing to redirect to, AC-7.4);
 *   - a tool route's access guard (src/router.tsx's per-tool `beforeLoad`)
 *     redirects here when the user has zero granted apps at all (AC-7.3).
 *
 * The surrounding chrome (Header/Sidebar/Footer, rendered by the parent
 * `_shell` layout route) stays fully mounted and interactive — sign-out,
 * the About dialog, and the theme toggle all keep working from here
 * (design.md Flow F8 step 2).
 *
 * A11y (design.md "Accessibility → Permission-denied / no-access states"):
 * the heading receives programmatic focus on mount — same technique
 * ShellLayout already uses for its skip-link target (`tabIndex={-1}` +
 * `ref.current?.focus()`) — so assistive tech announces the state
 * immediately instead of requiring the user to explore the page to discover
 * why nothing loaded. There is nothing to visually load here (no fetch, no
 * loading state) — the empty state is the direct, synchronous result of the
 * route's `beforeLoad`/render, so no separate loading treatment is needed.
 */
import { useEffect, useRef } from 'react'

export function NoAccessScreen() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-disp text-lg font-semibold text-text outline-none"
      >
        No apps available yet
      </h1>
      <p className="max-w-sm text-sm text-muted">
        Ask your administrator to grant you access to a tool.
      </p>
    </div>
  )
}

export default NoAccessScreen

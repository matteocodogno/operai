import { type MouseEvent, type ReactNode, useCallback } from 'react'
import { Outlet } from '@tanstack/react-router'

/**
 * ShellLayout — the persistent multi-region app-shell frame (specs/003-suite-shell,
 * T5, AC-1.1).
 *
 * Four landmark regions, mounted once for the whole suite session:
 *   - header   → `role="banner"`   — suite chrome (logo/About/avatar/theme, T6)
 *   - sidebar  → `<nav>`           — tool switcher (EstimAI/Refund, T7)
 *   - content  → `<main>`          — the active tool, rendered via TanStack Router's
 *                                    `<Outlet/>` so the router (T9) can mount
 *                                    `/estimai/*` and `/refund/*` here without this
 *                                    component being remounted on tool switches
 *                                    (AC-1.2 — chrome must not remount/flicker).
 *   - footer   → `role="contentinfo"` — legal/version/company info (T8)
 *
 * Desktop-only per the spec's explicit non-goal (no mobile/collapsed/drawer
 * variants) — a fixed header-then-(sidebar+content)-then-footer column, not a
 * responsive grid.
 *
 * `header`/`sidebar`/`footer` are optional slots: T6/T7/T8 pass their real
 * components in from the router once built. Until then (and in isolation, e.g.
 * this file's own component test) each region falls back to a clearly-labeled
 * placeholder, so the layout skeleton is testable and renderable on its own
 * without waiting on those tasks, and so those tasks fill the slots without
 * restructuring this component.
 *
 * Single-main-landmark note (design.md "Accessibility"): this is the suite's
 * only `<main>`. Remote root components mounted here via `<Outlet/>` (EstimAI,
 * Refund — T12/T15) must NOT render their own top-level `<main>`/`<header
 * role="banner">`/`<footer role="contentinfo">` — they render *inside* this
 * `<main>` as ordinary content. EstimAI's existing fixed-position "shortcuts"
 * footer is fine as-is: nested inside a sectioning root (`<main>`), a
 * `<footer>` is not a top-level contentinfo landmark per the HTML spec, so it
 * does not create a second contentinfo alongside the shell's own footer below.
 */

export const SHELL_MAIN_CONTENT_ID = 'shell-main-content'

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/50'

export interface ShellLayoutProps {
  /** Header chrome slot — filled by T6. Falls back to a placeholder banner. */
  header?: ReactNode
  /** Tool-switcher sidebar slot — filled by T7. Falls back to a placeholder list. */
  sidebar?: ReactNode
  /** Suite footer slot — filled by T8. Falls back to a placeholder footer. */
  footer?: ReactNode
}

export function ShellLayout({ header, sidebar, footer }: ShellLayoutProps) {
  // Belt-and-braces skip link: `href="#id"` + a focusable (tabIndex=-1) target
  // is enough in every modern browser, but jsdom/older engines don't always
  // move focus on a same-document fragment click (especially a second click
  // to the same hash, which doesn't fire `hashchange`). Handling it
  // explicitly makes the "jumps focus to the main region" behavior reliable
  // and directly testable, while still updating the URL fragment like a
  // normal anchor would.
  const handleSkipToContent = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    window.history.pushState(null, '', `#${SHELL_MAIN_CONTENT_ID}`)
    document.getElementById(SHELL_MAIN_CONTENT_ID)?.focus()
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-ink font-body text-text">
      {/* First focusable element in the document (AC-1.1 / Accessibility). */}
      <a
        href={`#${SHELL_MAIN_CONTENT_ID}`}
        onClick={handleSkipToContent}
        className={`sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-acc focus:px-4 focus:py-2 focus:text-ink ${FOCUS_RING}`}
      >
        Skip to content
      </a>

      <header role="banner" className="shrink-0 border-b border-rule bg-ink-soft">
        {header ?? <ShellHeaderPlaceholder />}
      </header>

      <div className="flex flex-1">
        <nav
          aria-label="Tool navigation"
          className="w-56 shrink-0 border-r border-rule bg-ink-soft"
        >
          {sidebar ?? <ShellSidebarPlaceholder />}
        </nav>

        {/* `tabIndex={-1}` makes this a valid skip-link target without adding
            it to the normal tab order (it's a landmark, not a control). */}
        <main id={SHELL_MAIN_CONTENT_ID} tabIndex={-1} className={`min-w-0 flex-1 ${FOCUS_RING}`}>
          <Outlet />
        </main>
      </div>

      <footer role="contentinfo" className="shrink-0 border-t border-rule bg-ink-soft">
        {footer ?? <ShellFooterPlaceholder />}
      </footer>
    </div>
  )
}

function ShellHeaderPlaceholder() {
  return (
    <p className="px-4 py-3 text-sm text-muted">
      Header placeholder — suite chrome (logo, About, user menu, theme toggle) lands in T6.
    </p>
  )
}

function ShellSidebarPlaceholder() {
  return (
    <p className="px-4 py-3 text-sm text-muted">
      Sidebar placeholder — tool switcher (EstimAI, Refund) lands in T7.
    </p>
  )
}

function ShellFooterPlaceholder() {
  return (
    <p className="px-4 py-3 text-sm text-muted">
      Footer placeholder — legal link, version, company info land in T8.
    </p>
  )
}

export default ShellLayout

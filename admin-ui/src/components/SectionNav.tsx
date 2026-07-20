import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'

// The four admin sections, in the IA order design.md uses consistently
// throughout (Screens A1/B1/C1/D1 — Roles, Departments, Users, Audit).
// `to` paths are relative to admin-ui's own inner router (see ../router.tsx)
// — TanStack Router prefixes them with the router's `basepath` (`/admin` when
// mounted as the federated remote, none in the standalone dev/test bootstrap)
// automatically, so this list never hardcodes `/admin`.
const SECTIONS = [
  { to: '/roles', label: 'Roles' },
  { to: '/departments', label: 'Departments' },
  { to: '/users', label: 'Users' },
  { to: '/audit', label: 'Audit' },
] as const

// Screen ADM-1 (T11, specs/009-mileage-rate) — a FIFTH section, but unlike
// the four above it is proactively hidden for a caller who lacks `rate:read`
// (design.md F7 — "the first capability-driven proactive UI hide" in this
// app; every existing section is always in this list because every existing
// section has no per-resource capability gate of its own, only the whole-tool
// admin-ui guard the shell already runs before this component ever mounts).
const RATES_SECTION = { to: '/rates', label: 'Mileage Rates' } as const

/**
 * SectionNav — admin-ui's section switcher (T14, specs/004-auth-roles-permissions,
 * design.md component inventory: "admin-ui secondary nav
 * (Roles/Departments/Users/Audit tabs) — NEW"). Mounted once by AdminShell
 * (../components/AdminShell.tsx), the inner router's root route component,
 * so it persists across every section while `<Outlet/>` swaps in
 * `../pages/*Page.tsx`.
 *
 * Accessibility (this task's explicit bar — "real `<a>`/`<nav>`, `aria-current`
 * on the active section — mirror the shell Sidebar's conventions"):
 *   - A real `<nav aria-label="Admin sections">` landmark, distinct from the
 *     shell's own `<nav aria-label="Tool navigation">` (ShellLayout) that
 *     wraps the Sidebar tool-switcher one level up when admin-ui is mounted
 *     inside the shell — two differently-labelled nav landmarks for two
 *     different jobs (suite tool switcher vs. this tool's own section
 *     switcher) is correct, not a duplicate landmark.
 *   - Real `<a>`s via TanStack Router's `<Link>`, never a `<div>`/`<button>`
 *     pretending to be tab strip — same posture design.md calls out
 *     generally ("every new interactive element is a native
 *     `<button>`/`<select>`/`<input>`/`<a>`").
 *   - `aria-current="page"` on the active section comes from `<Link>` itself
 *     (its `STATIC_ACTIVE_PROPS`, applied whenever the link's `to` matches
 *     the current location) — the exact mechanism
 *     `shell/src/components/Sidebar.tsx`'s doc comment describes and this
 *     task asks to mirror; no manual `aria-current` bookkeeping here.
 *
 * Deliberately simpler than Sidebar: no icon-collapse mode and no
 * roving-tabindex. Sidebar's roving-tabindex machinery exists to support its
 * collapsible icon-only rail; this is a flat, always-expanded list of four
 * text labels, so plain native tab order is the correct, proportionate a11y
 * posture — adding Sidebar's extra keyboard handling here would solve a
 * problem this nav doesn't have.
 *
 * Mileage Rates gate (T11, specs/009-mileage-rate, design.md F7): fetches
 * the caller's live effective permissions via `adminApi.getMe()` (`GET
 * /authz/me` — the same call this app already exposes) on mount, and only
 * then appends the "Mileage Rates" entry if `rate:read` is present. Defaults
 * to HIDDEN (never briefly flashes the entry before hiding it) and fails
 * CLOSED on any error — absence of a resolved grant is treated as no access,
 * matching the suite's established "resolve, never throw" posture
 * (shell/src/lib/session.ts's `usePermissions`/`EMPTY_PERMISSIONS` doc). This
 * is UX only — refund-api enforces `rate:read`/`rate:manage` server-side on
 * every `/rates` request regardless of what this nav shows (plan.md
 * Security section); a reactive `PermissionDenied` on the route itself
 * (MileageRatesPage.tsx) is the defense-in-depth fallback for a stale nav
 * render or a direct URL visit.
 */
export default function SectionNav() {
  const [hasRateRead, setHasRateRead] = useState(false)

  useEffect(() => {
    let cancelled = false

    adminApi
      .getMe()
      .then((me) => {
        if (cancelled) return
        const canRead = me.permissions.some((p) => p.resource === 'rate' && p.action === 'read')
        setHasRateRead(canRead)
      })
      .catch(() => {
        // Fail closed — leave hasRateRead at its default (false).
      })

    return () => {
      cancelled = true
    }
  }, [])

  const sections = hasRateRead ? [...SECTIONS, RATES_SECTION] : SECTIONS

  return (
    <nav aria-label="Admin sections">
      <ul className="mx-auto flex max-w-5xl gap-1 px-6">
        {sections.map((section) => (
          <li key={section.to}>
            <Link
              to={section.to}
              className="inline-block border-b-2 border-transparent px-3 py-3 text-sm font-medium transition-colors hover:text-[var(--text)]"
              style={{ color: 'var(--soft)' }}
              activeProps={{
                style: { color: 'var(--acc)', borderColor: 'var(--acc)' },
              }}
            >
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

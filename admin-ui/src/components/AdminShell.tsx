import { Outlet } from '@tanstack/react-router'
import SectionNav from './SectionNav'

/**
 * AdminShell — admin-ui's own root layout, wired as the inner router's root
 * route component (see ../router.tsx's `createRootRoute({ component:
 * AdminShell })`). This is "the App root that renders the nav + an
 * `<Outlet/>`" this task's description asks for: a heading identifying the
 * tool, the section nav (Roles/Departments/Users/Audit — ./SectionNav.tsx),
 * and the `<Outlet/>` the four section routes (../pages/*Page.tsx) and the
 * not-found fallback (../pages/NotFoundPage.tsx) render into.
 *
 * No suite chrome duplicated here (Header/Footer/UserMenu/ThemeToggle,
 * sign-out, …) — per the plan's federation contract (ADR-0006) and
 * design.md's component inventory ("Shell chrome … Reuse (shared),
 * unchanged … none of this feature's flows touch chrome"), that chrome
 * already exists once in the shell and wraps admin-ui when it's mounted
 * there; duplicating any of it here (including an identity/sign-out
 * affordance) would be a second, redundant copy of chrome the shell already
 * owns. No auth guard either, same rationale as estimai-ui's router
 * (specs/003-suite-shell, AC-2.3): the shell's own `_authed` guard (and, per
 * a later task of this feature, a per-tool `access` guard) already runs
 * before admin-ui is ever mounted.
 */
export default function AdminShell() {
  return (
    <div className="min-h-screen" style={{ color: 'var(--text)', fontFamily: 'var(--body)' }}>
      <header style={{ borderBottom: '1px solid var(--rule)', backgroundColor: 'var(--ink-soft)' }}>
        <div className="mx-auto max-w-5xl px-6 py-4">
          <h1 className="text-xl font-bold" style={{ fontFamily: 'var(--disp)' }}>
            Admin
          </h1>
        </div>
        <SectionNav />
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

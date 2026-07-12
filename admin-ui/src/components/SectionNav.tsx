import { Link } from '@tanstack/react-router'

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
 */
export default function SectionNav() {
  return (
    <nav aria-label="Admin sections">
      <ul className="mx-auto flex max-w-5xl gap-1 px-6">
        {SECTIONS.map((section) => (
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

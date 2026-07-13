import { Link } from '@tanstack/react-router'

// The two Users-section views, in the order design.md's Screen U1/U2 uses
// consistently ("Active users" | "Invitations"). `to` paths are relative to
// admin-ui's own inner router (see ../router.tsx) — TanStack Router prefixes
// them with the router's `basepath` automatically, same as ../components/
// SectionNav.tsx's own `SECTIONS` list.
const VIEWS = [
  { to: '/users', label: 'Active users' },
  { to: '/users/invitations', label: 'Invitations' },
] as const

/**
 * UsersSubNav — the Users section's own two-tab strip (T10,
 * specs/006-user-invitations, design.md Screen U1: "UsersSubNav — a two-item
 * tab strip … above the existing search input"). Rendered independently by
 * both `../pages/UsersPage.tsx` (Screen U1) and `../pages/InvitationsPage.tsx`
 * (Screen U2) — unlike `SectionNav`, which is mounted once by `AdminShell`
 * and persists across every section, this is scoped to just these two
 * sibling views within the Users section and has no shared mount point.
 *
 * Accessibility (design.md Screen U1, "ported convention from `SectionNav.tsx`"):
 *   - A real `<nav aria-label="Users section views">` landmark — deliberately
 *     a DIFFERENT label from both `SectionNav`'s "Admin sections" and the
 *     shell's own "Tool navigation" (`ShellLayout`). Three differently
 *     labelled nav landmarks at three different levels (suite tool switcher →
 *     admin section switcher → this section's own view switcher) is correct
 *     landmark nesting, not a duplicate-landmark problem — same reasoning
 *     `SectionNav.tsx`'s own doc comment gives for its two-landmark case.
 *   - Real `<a>`s via `<Link>`, never a `<div>`/`<button>` pretending to be a
 *     tab strip.
 *   - `aria-current="page"` on the active view comes from `<Link>` itself
 *     (its `STATIC_ACTIVE_PROPS`), exactly like `SectionNav`. The "Active
 *     users" link uses `activeOptions={{ exact: true }}` so it does NOT also
 *     report active while on `/users/invitations` — without `exact`,
 *     TanStack Router's default fuzzy match would treat `/users` as a
 *     prefix-match ancestor of `/users/invitations` and mark both links
 *     current simultaneously (see `shell/src/components/Sidebar.tsx`'s doc
 *     comment on the same `activeOptions.exact` default-fuzzy-match pitfall).
 *     "Invitations" needs no such option — nothing is nested under it.
 */
export default function UsersSubNav() {
  return (
    <nav aria-label="Users section views" className="mb-4">
      <ul className="flex gap-1">
        {VIEWS.map((view) => (
          <li key={view.to}>
            <Link
              to={view.to}
              activeOptions={view.to === '/users' ? { exact: true } : undefined}
              data-testid={`users-subnav-${view.to === '/users' ? 'active' : 'invitations'}`}
              className="inline-block border-b-2 border-transparent px-3 py-2 text-sm font-medium transition-colors hover:text-[var(--text)]"
              style={{ color: 'var(--soft)' }}
              activeProps={{
                style: { color: 'var(--acc)', borderColor: 'var(--acc)' },
              }}
            >
              {view.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

import { Link } from '@tanstack/react-router'
import { Skeleton, TabNav, tabLinkClassName } from '@operai/ui'
import { strings } from '../strings'

// The left-anchored admin sections (Roles, Departments, Users). Audit is rendered separately,
// anchored to the FAR RIGHT (2026-07-21 UX change).
// `to` paths are relative to admin-ui's own inner router (see ../router.tsx)
// — TanStack Router prefixes them with the router's `basepath` (`/admin` when
// mounted as the federated remote, none in the standalone dev/test bootstrap)
// automatically, so this list never hardcodes `/admin`.
const SECTIONS = [
  { to: '/roles', label: strings.nav.roles },
  { to: '/departments', label: strings.nav.departments },
  { to: '/users', label: strings.nav.users },
] as const

// Audit — anchored to the far right of the nav (rendered via `ml-auto`), kept
// visually separate from the day-to-day management sections.
const AUDIT_SECTION = { to: '/audit', label: strings.nav.audit } as const

export type SectionNavProps = {
  /** Roles, Departments, Users and Audit: the person holds `admin:access` (today's meaning, unchanged). */
  showAdmin: boolean
  /**
   * Legal entities: `shown` when `GET /legal-entities/manageable` is not empty, `hidden` when it is empty or
   * could not be read (fails closed), `resolving` while the answer is on its way (a skeleton tab holds the place).
   */
  legalEntities: 'shown' | 'hidden' | 'resolving'
}

/**
 * SectionNav — admin-ui's section switcher (T14, specs/20260713-auth-roles-permissions,
 * design.md component inventory: "admin-ui secondary nav
 * (Roles/Departments/Users/Audit tabs) — NEW"), by capability since T35 (specs/20261117-legal-entities,
 * design S8, plan decision 5): a section the person may not use is ABSENT, never disabled. Mounted once by
 * AdminShell (../components/AdminShell.tsx), the inner router's root route component,
 * so it persists across every section while `<Outlet/>` swaps in
 * `../pages/*Page.tsx`. AdminShell owns the capability answers (it also needs them to redirect) and passes
 * them in.
 *
 * Accessibility (this task's explicit bar — "real `<a>`/`<nav>`, `aria-current`
 * on the active section — mirror the shell Sidebar's conventions"):
 *   - A real `<nav aria-label={strings.nav.sectionsLabel}>` landmark, distinct from the
 *     shell's own `<nav aria-label="Tool navigation">` (ShellLayout) that
 *     wraps the Sidebar tool-switcher one level up when admin-ui is mounted
 *     inside the shell — two differently-labelled nav landmarks for two
 *     different jobs (suite tool switcher vs. this tool's own section
 *     switcher) is correct, not a duplicate landmark. With nothing to list and nothing resolving there is no
 *     landmark at all (an empty one would be announced for nothing).
 *   - Real `<a>`s via TanStack Router's `<Link>`, never a `<div>`/`<button>`
 *     pretending to be tab strip — same posture design.md calls out
 *     generally ("every new interactive element is a native
 *     `<button>`/`<select>`/`<input>`/`<a>`").
 *   - `aria-current="page"` on the active section comes from `<Link>` itself
 *     (its `STATIC_ACTIVE_PROPS`, applied whenever the link's `to` matches
 *     the current location) — the exact mechanism
 *     `shell/src/components/Sidebar.tsx`'s doc comment describes and this
 *     task asks to mirror; no manual `aria-current` bookkeeping here.
 *   - The skeleton tab is `aria-hidden`; the page slot announces the loading (AdminShell).
 *   - `wrap` (plan E8): the row reflows onto further lines instead of scrolling sideways, and one long label
 *     may break (WCAG 1.4.10, 320 px).
 *
 * Deliberately simpler than Sidebar: no icon-collapse mode and no
 * roving-tabindex. Sidebar's roving-tabindex machinery exists to support its
 * collapsible icon-only rail; this is a flat, always-expanded list of a few
 * text labels, so plain native tab order is the correct, proportionate a11y
 * posture — adding Sidebar's extra keyboard handling here would solve a
 * problem this nav doesn't have.
 *
 * Time lists gate (T31, specs/029-time-tracking, AC-3.3): reads the caller's live
 * effective permissions through the suite's one mechanism, `shell/session`'s
 * `usePermissions()` (the shell's cached `GET /authz/me`), and only appends the
 * "Time lists" entry if `time-list:manage` is present. Until the permissions resolve
 * they are EMPTY, so the entry defaults to HIDDEN (never flashes in then out) and
 * fails CLOSED on any error (INC-32). This is UX only — hours-api enforces
 * `time-list:manage` live on every list write; `TimeListsPage` renders
 * `PermissionDenied` for a direct visit without it.
 */
export default function SectionNav({ showAdmin, legalEntities }: SectionNavProps) {
  if (!showAdmin && legalEntities === 'hidden') return null

  return (
    <TabNav
      label={strings.nav.sectionsLabel}
      wrap
      // Audit is pinned to the far right of the strip (TabNav's `end` slot).
      end={
        showAdmin ? (
          <Link key={AUDIT_SECTION.to} to={AUDIT_SECTION.to} className={tabLinkClassName}>
            {AUDIT_SECTION.label}
          </Link>
        ) : undefined
      }
    >
      {showAdmin &&
        SECTIONS.map((section) => (
          <Link key={section.to} to={section.to} className={tabLinkClassName}>
            {section.label}
          </Link>
        ))}
      {legalEntities === 'shown' && (
        <Link key="/legal-entities" to="/legal-entities" className={tabLinkClassName}>
          {strings.nav.legalEntities}
        </Link>
      )}
      {legalEntities === 'resolving' && <Skeleton key="resolving" width={112} height={20} />}
    </TabNav>
  )
}

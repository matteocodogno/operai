/**
 * UserMenu — presentational component.
 *
 * Relocated from estimai-ui/src/components/UserMenu.tsx (T6, specs/003-suite-shell,
 * AC-1.4; originally T8, specs/002) — as-is structurally.
 *
 * Renders the signed-in user's avatar as a button that opens a dropdown menu
 * containing the full name/email, a "My profile" link, and the sign-out control.
 *
 * Convention: receives all data and callbacks as props — no authClient, no fetch, no
 * session logic inside this component (project CLAUDE.md). The one exception is the
 * `onSignOut` default below: it's wired directly to the shell's shared session module
 * (`shell/session`, T4) so sign-out always terminates the suite-wide session rather than
 * a re-created auth client — still overridable via props for tests/composition.
 *
 * "My profile" (T15, specs/012-employee-address, US-6 AC-6.1, ADR-0034):
 * one new `role="menuitem"` row, between the identity block and "Sign out"
 * (design.md "`UserMenu` addition"), linking to the new `/account` route
 * (T14's `AccountScreen`, router.tsx) — a real `<Link>` (not a `<button>` +
 * manual navigate) so it participates in normal link semantics
 * (open-in-new-tab, keyboard activation) like every other in-suite
 * navigation. This is the ONLY existing entry point to that route (design.md
 * F6: "any signed-in user → UserMenu → 'My profile' → /account").
 *
 * "My devices" (T42, specs/015-hardware-inventory, AC-4.1, ADR-0045): a second
 * real `<Link role="menuitem">` directly after "My profile", to the ungated
 * `/devices` route. Shown to every signed-in user — no permission check here,
 * by design (the route and `/me/*` API are identity-scoped).
 *
 * "My meetings" (specs/021-meetings, AC-10.1, ADR-0045 shape): a third real
 * `<Link role="menuitem">` after "My devices", to the ungated `/my-meetings`
 * route. Shown to every signed-in user — no permission check here, by design (a
 * participant without `meetings:access` still reads the meetings they were added to).
 *
 * The menu itself — opening, keyboard (arrows, Home/End, Escape back to the
 * avatar), closing on choice or outside click — is the library `Menu`
 * (decisions D-60), shared with LogoMenu.
 *
 * i18n (INC-24/25): every label comes from the shell strings module, whose
 * language the library resolves once for the whole suite (`selectStrings`).
 * The menu's own `navigator.language` detection is gone.
 */

import { Link } from '@tanstack/react-router'
import { Menu, MenuItem } from '@operai/ui'
import { signOut } from '../lib/session'
import { strings } from '../strings'

type UserMenuUser = {
  name?: string | null
  email?: string | null
  image?: string | null
}

type UserMenuProps = {
  user: UserMenuUser
  onSignOut?: () => void
}

// `/my-meetings/$` is a splat route (the remote has an inner router), and the
// router's typed `to` only knows its `$` form; like Sidebar's `tool.to`, the
// bare prefix is passed as a plain string so the link renders `/my-meetings`.
const MY_MEETINGS_PATH: string = '/my-meetings'

const defaultOnSignOut = (): void => {
  void signOut()
}

const UserMenu = ({ user, onSignOut = defaultOnSignOut }: UserMenuProps) => {
  const displayName = user.name || user.email || strings.userMenu.accountFallback
  const initial = displayName.charAt(0).toUpperCase()
  // Show the email as a secondary line only when we also have a distinct name.
  const secondary = user.name && user.email ? user.email : null

  return (
    <Menu
      triggerShape="round"
      triggerTitle={displayName}
      align="end"
      testIdPrefix="user-menu"
      trigger={
        user.image ? (
          <img
            src={user.image}
            alt={displayName}
            // Google (lh3.googleusercontent.com) and other providers 403/429 avatar
            // requests that carry a cross-origin Referer header — omit it so the
            // avatar actually loads.
            referrerPolicy="no-referrer"
            className="w-7 h-7 rounded-full object-cover border border-rule shrink-0"
            aria-label={displayName}
          />
        ) : (
          <span
            className="w-7 h-7 rounded-full bg-acc/20 text-acc text-2xs font-bold font-mono flex items-center justify-center shrink-0 border border-acc/30"
            aria-label={displayName}
          >
            {initial}
          </span>
        )
      }
      header={
        <>
          <div className="truncate">{displayName}</div>
          {secondary && <div className="menu-header-secondary truncate">{secondary}</div>}
        </>
      }
    >
      <Link to="/account" role="menuitem" className="menu-item">
        {strings.userMenu.myProfile}
      </Link>
      <Link to="/devices" role="menuitem" className="menu-item">
        {strings.userMenu.myDevices}
      </Link>
      <Link to={MY_MEETINGS_PATH} role="menuitem" className="menu-item">
        {strings.userMenu.myMeetings}
      </Link>
      <MenuItem onClick={onSignOut}>{strings.userMenu.signOut}</MenuItem>
    </Menu>
  )
}

export default UserMenu

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
 * i18n (QE fix, specs/012-employee-address): "My profile" is copy this
 * feature ADDS, and design.md's own i18n table names it explicitly
 * (`account.menuLabel` → "My profile" / "Il mio profilo") — unlike "Sign
 * out" below (pre-existing, predates specs/012, a separate app-wide gap this
 * feature does not create or fix, mirroring R11's posture for admin-ui). The
 * `t()`/`resolveLocale()` pair mirrors `AccountScreen.tsx`'s identical
 * stateless heuristic verbatim (`navigator.language` starting with `"it"` →
 * `it`, else `en`) — the same convention, not a second one invented here.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { signOut } from '../lib/session'

const COPY = {
  myProfile: { en: 'My profile', it: 'Il mio profilo' },
} as const

type CopyKey = keyof typeof COPY

/** `navigator.language` starting with "it" selects `it`, everything else falls back to `en`. */
function resolveLocale(): 'it' | 'en' {
  if (typeof navigator === 'undefined' || typeof navigator.language !== 'string') {
    return 'en'
  }
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

function t(key: CopyKey): string {
  return COPY[key][resolveLocale()]
}

type UserMenuUser = {
  name?: string | null
  email?: string | null
  image?: string | null
}

type UserMenuProps = {
  user: UserMenuUser
  onSignOut?: () => void
}

const defaultOnSignOut = (): void => {
  void signOut()
}

const UserMenu = ({ user, onSignOut = defaultOnSignOut }: UserMenuProps) => {
  const displayName = user.name || user.email || 'Account'
  const initial = displayName.charAt(0).toUpperCase()
  // Show the email as a secondary line only when we also have a distinct name.
  const secondary = user.name && user.email ? user.email : null

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center rounded-full shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-acc/50"
        aria-haspopup="menu"
        aria-expanded={open}
        title={displayName}
      >
        {user.image ? (
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
            className="w-7 h-7 rounded-full bg-acc/20 text-acc text-[11px] font-bold font-mono flex items-center justify-center shrink-0 border border-acc/30"
            aria-label={displayName}
          >
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 min-w-[180px] max-w-[240px] bg-ink-soft border border-rule rounded-lg shadow-2xl z-50 py-1"
        >
          <div className="px-3 py-2 border-b border-rule">
            <div className="text-[12px] text-text font-medium truncate">{displayName}</div>
            {secondary && (
              <div className="text-[11px] text-muted font-mono truncate">{secondary}</div>
            )}
          </div>
          <Link
            to="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full text-left text-[12px] text-soft hover:text-text hover:bg-ink-mid px-3 py-2 transition-colors font-mono"
          >
            {t('myProfile')}
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="w-full text-left text-[12px] text-soft hover:text-text hover:bg-ink-mid px-3 py-2 transition-colors font-mono"
            aria-label="Sign out"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export default UserMenu

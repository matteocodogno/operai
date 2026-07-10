/**
 * Header — composes the T6 header chrome for the `_shell` layout route (T9,
 * specs/003-suite-shell, AC-1.4).
 *
 * Wiring only: every piece it composes (LogoMenu, UserMenu, ThemeToggle,
 * AboutModal) already exists as its own file from T6. Extracted to its own
 * file (rather than defined inline in router.tsx) for two reasons:
 *   - It's a real, reusable component, matching this codebase's
 *     one-component-per-file convention (LogoMenu/UserMenu/ThemeToggle/
 *     AboutModal/Footer are all their own files).
 *   - `react-refresh/only-export-components` flags a component defined
 *     alongside router.tsx's non-component exports (`routeTree`, `router`)
 *     as a Fast Refresh boundary violation — router.tsx must only export
 *     components for HMR to invalidate correctly, and it exports the route
 *     tree/router by necessity.
 *
 * UserMenu's sign-out is already wired to shell/session's signOut by its own
 * default `onSignOut` (see UserMenu.tsx) — nothing to pass here. The
 * suite-wide `_authed` guard (router.tsx) guarantees a session exists before
 * this ever mounts, but useSession() is a separate reactive subscription
 * from the guard's one-shot getSession() call, so `user` is guarded with a
 * truthiness check rather than assumed non-null (mirrors EstimatorApp.tsx's
 * existing `authClient.useSession()` usage in estimai-ui).
 */
import { useState } from 'react'
import LogoMenu from './LogoMenu'
import UserMenu from './UserMenu'
import ThemeToggle from './ThemeToggle'
import AboutModal from './AboutModal'
import { useSession } from '../lib/session'

export default function Header() {
  const [aboutOpen, setAboutOpen] = useState(false)
  const { data } = useSession()
  const user = data?.user

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <LogoMenu onAbout={() => setAboutOpen(true)} />
      <div className="flex items-center gap-3">
        <ThemeToggle />
        {user && <UserMenu user={user} />}
      </div>
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </div>
  )
}

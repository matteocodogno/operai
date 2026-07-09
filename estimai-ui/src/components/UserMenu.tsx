/**
 * UserMenu — presentational component (T8, specs/002).
 *
 * Renders the signed-in user's avatar as a button that opens a dropdown menu
 * containing the full name/email and the sign-out control. The name is no
 * longer shown inline in the header — it lives in the dropdown.
 *
 * Convention: receives all data and callbacks as props — no authClient, no
 * fetch, no session logic inside this component.
 */

import { useEffect, useRef, useState } from 'react'

type UserMenuUser = {
  name?: string | null
  email?: string | null
  image?: string | null
}

type UserMenuProps = {
  user: UserMenuUser
  onSignOut: () => void
}

const UserMenu = ({ user, onSignOut }: UserMenuProps) => {
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

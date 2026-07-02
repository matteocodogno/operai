/**
 * UserMenu — presentational component (T8, specs/002).
 *
 * Displays the signed-in user's name and/or avatar with a sign-out control.
 *
 * Convention: receives all data and callbacks as props — no authClient, no
 * fetch, no session logic inside this component.
 */

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

  return (
    <div className="flex items-center gap-2">
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
      <span className="hidden sm:block text-[12px] text-soft font-mono truncate max-w-[120px]">
        {displayName}
      </span>
      <button
        onClick={onSignOut}
        className="text-muted text-[11px] py-1 px-2 border border-rule hover:text-text hover:border-text/40 transition-colors font-mono"
        aria-label="Sign out"
        title="Sign out"
      >
        Sign out
      </button>
    </div>
  )
}

export default UserMenu

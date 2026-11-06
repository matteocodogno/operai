import { useSession } from 'shell/session'

/** The signed-in user's id (the JWT `sub`), or null before the session resolves. */
export function useCurrentUserId(): string | null {
  return useSession().data?.user?.id ?? null
}

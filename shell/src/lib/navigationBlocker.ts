/**
 * The navigation-blocker registry (specs/021-meetings, T50, AC-2.10).
 *
 * A remote that must not be left casually (meetings-ui while it is recording or
 * holds unsaved chunks) calls `registerNavigationBlocker(shouldBlock, message)`
 * through `shell/session`; the shell's `ShellLayout` reads this registry from a
 * router `useBlocker` and asks the person to confirm before in-app navigation.
 * Browser tab close / reload stays the remote's own `beforeunload` (the shell
 * cannot know the remote's state there, and the remote is the one that must
 * stop and save on a confirmed leave).
 *
 * Why its own module and not inline in session.ts: `session.ts` is mocked
 * wholesale (explicit factories) by most router tests, and ShellLayout would
 * otherwise force every one of those mocks to learn a new export. `session.ts`
 * re-exports `registerNavigationBlocker`, so the federated seam is unchanged.
 *
 * Module-scope memory only (ADR-0001's posture): nothing here is persisted.
 *
 * Failure posture (ADR-0030, ADR-0060): a broken remote must never trap the
 * person. A `shouldBlock` that throws counts as "do not block", and an
 * unregister from a replaced registration never removes the newer one.
 */

export interface NavigationBlocker {
  /** Asked at the moment of navigation; true = ask the person first. */
  shouldBlock: () => boolean
  /** The remote's own explanation, shown as the confirmation body. */
  message: string
}

let current: NavigationBlocker | null = null

/**
 * Registers the (single, newest-wins) blocker and returns its unregister
 * function. Idempotent; a stale unregister is a no-op once replaced.
 */
export const registerNavigationBlocker = (shouldBlock: () => boolean, message: string): (() => void) => {
  const blocker: NavigationBlocker = { shouldBlock, message }
  current = blocker
  return () => {
    if (current === blocker) {
      current = null
    }
  }
}

/** The registered blocker, or null. */
export const getNavigationBlocker = (): NavigationBlocker | null => current

/** True when a blocker is registered and answers "block" right now. Never throws. */
export const isNavigationBlocked = (): boolean => {
  if (!current) {
    return false
  }
  try {
    return current.shouldBlock() === true
  } catch {
    return false
  }
}

/** Empties the registry (test isolation). */
export const resetNavigationBlocker = (): void => {
  current = null
}

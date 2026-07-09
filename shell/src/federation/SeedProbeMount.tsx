import { Suspense, lazy, useCallback, useState } from 'react'
import * as ReactRuntime from 'react'

/**
 * R1 GATE (specs/003-suite-shell/tasks.md, T2) — federation walking skeleton.
 *
 * Mounts the throwaway `mf-seed-remote`'s exposed `SeedProbe` component via
 * the Module Federation runtime (`import('seed/SeedProbe')`) and proves the
 * two things T2's done-when requires:
 *
 *  1. The shell can load and render a remote's exposed component at runtime.
 *  2. `react`/`react-dom` resolve to a *single shared instance* across the
 *     host↔remote boundary (ADR-0006 risks R1/R2), not two separate copies.
 *
 * For (2): SeedProbe calls `onReady(reactModuleItImported)` from a
 * `useEffect` on mount, handing this component the `react` module object *it*
 * imported. This component then checks two things — deliberately NOT whole
 * namespace-object identity (`remoteReact === ReactRuntime`):
 *
 *   - `import * as X from 'react'` produces a *per-bundle* ES module
 *     namespace object. Because the host and remote are two separately
 *     built/rolled-up chunks, each gets its own namespace wrapper even when
 *     Module Federation's `shared`/`singleton: true` negotiation correctly
 *     dedupes the underlying module — so namespace-object equality is
 *     always false here and is not evidence of anything. (Verified: logging
 *     it during development showed `false` even though the checks below,
 *     which ARE the properties that matter, were `true`.)
 *   - What actually matters for "no duplicate React" is whether the *hook
 *     implementation* and the *dispatcher internals* React itself consults
 *     are the same object across the boundary. `useState` reference equality
 *     proves the same hook function runs for both host and remote code.
 *     `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`
 *     reference equality proves both sides share the same current-dispatcher
 *     bookkeeping object — the exact mechanism whose duplication causes the
 *     classic MF "Invalid hook call" failure. If the shared negotiation had
 *     failed and each side loaded its own React copy, these would differ and
 *     the remote's hook calls would either diverge from this check or throw
 *     outright when rendered under the host's react-dom reconciler.
 */
export interface ReactInternalsProbe {
  useState: unknown
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: unknown
}

const RemoteSeedProbe = lazy(() => import('seed/SeedProbe'))

export type SingletonCheckState = 'pending' | 'shared' | 'diverged'

export function SeedProbeMount() {
  const [singletonCheck, setSingletonCheck] = useState<SingletonCheckState>('pending')

  const handleRemoteReady = useCallback((remoteReact: typeof ReactRuntime) => {
    const host = ReactRuntime as unknown as ReactInternalsProbe
    const remote = remoteReact as unknown as ReactInternalsProbe

    const sameHookImplementation = remote.useState === host.useState
    const sameDispatcherInternals =
      remote.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ===
      host.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

    const isSharedInstance = sameHookImplementation && sameDispatcherInternals
    setSingletonCheck(isSharedInstance ? 'shared' : 'diverged')

    // Also surface on `window` so an out-of-process driver (Playwright) can
    // assert on it directly, in addition to the on-page test id below.
    if (typeof window !== 'undefined') {
      window.__mfSingletonCheck = isSharedInstance
    }

    console.log(
      `[T2 R1 gate] shared React singleton: useState fn equal=${sameHookImplementation}, dispatcher internals equal=${sameDispatcherInternals} → ${isSharedInstance ? 'SHARED (singleton OK)' : 'DIVERGED (duplicate React!)'}`,
    )
  }, [])

  return (
    <section data-testid="seed-probe-mount">
      <Suspense fallback={<p data-testid="seed-probe-loading">loading seed remote…</p>}>
        <RemoteSeedProbe onReady={handleRemoteReady} />
      </Suspense>
      <p data-testid="singleton-check" data-status={singletonCheck}>
        React singleton check: {singletonCheck}
      </p>
    </section>
  )
}

declare global {
  interface Window {
    /** Set by SeedProbeMount once the remote reports its `react` module. */
    __mfSingletonCheck?: boolean
  }
}

/**
 * useLoadedResource — one fetch state machine for a card that loads one resource
 * (specs/20261118-refund-accounting-export, design.md component #46). The five new Settings cards would
 * each repeat the 40-line effect `SettingsPage` carries; this is that effect once.
 *
 *   loading    nothing to show yet
 *   loaded     `data` is the server's answer (kept on screen while a `reload()` is in flight)
 *   error      the loader failed with anything but a 403 (`error` is what it threw)
 *   forbidden  the loader answered 403, or `enabled` is false — the capability is absent, so the card is
 *              left out (UX-9), exactly as the email card hides itself today. Fails closed; the real
 *              boundary is refund-api's own capability check.
 *
 * Written as a Promise chain, never an async function called from the effect, so state is only set
 * from a callback (react-hooks/set-state-in-effect; see SettingsPage).
 *
 * `loader` may be an inline arrow: only `enabled` and `reload()` start a new load, never its identity
 * (the latest loader is read at the start of each load). A response that arrives after a newer load
 * started, or after unmount, is dropped.
 *
 * `reload()` keeps the current data visible instead of going back to a skeleton: a row the user just
 * acted on must still be in the DOM so focus can be moved to it. `replace(data)` swaps in a fresher
 * value the caller already holds (a PUT that returns the whole row) without another request; `replace(fn)`
 * patches the current value, which is what an async write must use (its closure may be stale by then).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './refundApi'

export type ResourceState<T> =
  { status: 'loading' } | { status: 'loaded'; data: T } | { status: 'error'; error: unknown } | { status: 'forbidden' }

export type LoadedResource<T> = ResourceState<T> & {
  /** Load again. A loaded resource stays `loaded` (with its old data) until the new answer arrives. */
  reload: () => void
  /**
   * Show `data` as the loaded value now (for a write that returned the fresh resource). Given a function, it
   * receives the data as it is when it runs (not as it was when the write started) and returns the new value;
   * on a resource that is not loaded it does nothing, since there is nothing to patch.
   */
  replace: (data: T | ((current: T) => T)) => void
}

export function useLoadedResource<T>(loader: () => Promise<T>, enabled = true): LoadedResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const loaderRef = useRef(loader)

  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    Promise.resolve()
      .then(() => {
        // Keep loaded data on screen across a reload; anything else starts from a skeleton.
        if (!cancelled) setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }))
      })
      .then(() => loaderRef.current())
      .then((data) => {
        if (!cancelled) setState({ status: 'loaded', data })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState(
          error instanceof ApiError && error.status === 403 ? { status: 'forbidden' } : { status: 'error', error },
        )
      })

    return () => {
      cancelled = true
    }
  }, [enabled, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const replace = useCallback(
    (data: T | ((current: T) => T)) =>
      setState((current) => {
        if (typeof data !== 'function') return { status: 'loaded', data }
        return current.status === 'loaded'
          ? { status: 'loaded', data: (data as (value: T) => T)(current.data) }
          : current
      }),
    [],
  )

  const visible: ResourceState<T> = enabled ? state : { status: 'forbidden' }
  return { ...visible, reload, replace }
}

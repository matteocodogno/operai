import 'shell/tokens.css'
import { useState, useSyncExternalStore } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from './components/CrmShell'
import { createAppRouter, type AppRouter } from './router'

// The exposed remote MUST NOT import its own index.css: the shell owns the one
// Tailwind sheet of the suite (ADR-0006 addendum, ADR-0051). Only the
// standalone bootstrap (main.tsx) imports index.css.

const BASEPATH = '/crm'

/**
 * The router of one mount (specs/022 AC-6.1, D52). A router created once at module
 * load outlives every unmount: its browser history keeps listening to the whole
 * window, so it routes the other modules' addresses too and renders that stale match
 * when the shell mounts the module again. So the router is made when the module
 * mounts and its history destroyed (listeners and `pushState` patch included) when
 * it unmounts.
 *
 * It also ignores the browser's address while that address is not the module's own:
 * between the shell moving the URL to another module and unmounting this one (the
 * other module is still loading) nothing here routes it, so no page, and no request,
 * comes from an address that is not ours.
 *
 * And it follows the address for as long as the module is mounted, not for as long as
 * React shows it (specs/022 AC-6.2, D53). The shell's own router hears every browser
 * back and forward first and hides this module behind its pending fallback while its
 * access guard answers; React then cleans up this router's layout effects, among them
 * TanStack Router's subscription of `router.load` to the history, BEFORE this history
 * hears the same change. The change reaches no subscriber, and when the module is shown
 * again the subscription comes back without loading what it missed (in development):
 * the address moves, the page does not. So the subscription is kept until the history
 * is destroyed, which is when the module unmounts, and React's cleanup of it is a no-op.
 */
function createOwnRouter(): AppRouter {
  const router = createAppRouter(BASEPATH, CrmShell)
  const { history } = router
  const subscribe = history.subscribe
  const destroy = history.destroy
  // One subscriber per listener, however often React subscribes it again (strict mode, shown again).
  type Listener = Parameters<typeof subscribe>[0]
  const subscribed = new WeakMap<Listener, Listener>()
  history.subscribe = (listener) => {
    let own = subscribed.get(listener)
    if (!own) {
      own = (event) => {
        const path = event.location.pathname.toLowerCase()
        if (path === BASEPATH || path.startsWith(`${BASEPATH}/`)) listener(event)
      }
      subscribed.set(listener, own)
    }
    subscribe(own)
    return () => undefined
  }
  history.destroy = () => {
    history.subscribers.clear()
    destroy()
  }
  return router
}

/**
 * The router as an external store whose subscription is the mount: React subscribes
 * after it commits and unsubscribes when it unmounts, and strict mode's mount,
 * unmount, mount leaves exactly one router with its history listening.
 *
 * React also runs a subscription's cleanup and setup again on a component that stays
 * mounted: strict mode does it when the shell shows the module again after hiding it
 * behind its pending fallback. That swaps the router with no render in between, so the
 * snapshot carries a `key` that changes with the router: a swapped router gets a fresh
 * `RouterProvider`, because a provider already mounted never loads a router it was
 * not mounted with (TanStack Router's `Transitioner`, in development) and the module
 * would come back blank.
 */
function ownRouterMount() {
  let current: { router: AppRouter; key: number } | null = null
  let generation = 0
  return {
    subscribe: (onChange: () => void) => {
      current = { router: createOwnRouter(), key: ++generation }
      onChange()
      return () => {
        current?.router.history.destroy()
        current = null
      }
    },
    getCurrent: () => current,
  }
}

/**
 * App — crm-ui's gated tool root, exposed via Module Federation as `./App`
 * (vite.config.ts) and mounted by the shell at the access-gated `/crm/*`
 * (specs/017-crm). An inner TanStack Router rebased to `/crm`, with
 * `CrmShell` as its root layout; no auth guard and no chrome (the shell owns
 * both).
 */
export default function App() {
  const [mount] = useState(ownRouterMount)
  const own = useSyncExternalStore(mount.subscribe, mount.getCurrent)
  return own ? <RouterProvider key={own.key} router={own.router} /> : null
}

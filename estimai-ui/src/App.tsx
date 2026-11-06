import { useState, useSyncExternalStore } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter, type AppRouter } from './router'

// IMPORTANT (specs/003-suite-shell; docs/adr/0006 Remote CSS strategy): the
// exposed remote MUST NOT import its own `index.css` here. The shell owns the
// single Tailwind sheet for the whole suite — its Tailwind `@source`-scans
// estimai-ui/src (shell/src/index.css) and generates estimai's utility classes
// from the shared `@theme` (shell/src/styles/tokens.css). Importing estimai's
// own compiled Tailwind here would put a SECOND full Tailwind sheet on the
// shell's page; the two sheets' `@layer utilities` merge by DOM order, so the
// later sheet's plain utilities clobber the earlier sheet's variant utilities
// (`sm:*`/`hover:*`/`focus:*`) — the double-header / broken-responsive bug.
// The standalone bootstrap (main.tsx) DOES import index.css: outside the shell
// there is no shell sheet, so it's estimai's only source of Tailwind + tokens.

const BASEPATH = '/estimai'

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
  const router = createAppRouter(BASEPATH)
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

// T12 (specs/003-suite-shell/tasks.md): root component exposed via Module
// Federation as `./App` (see vite.config.ts's `exposes`). This is what the
// shell's `/estimai/*` catch-all route (T9) mounts. The inner TanStack
// Router is rebased to basepath '/estimai' so estimai-ui's own internal
// navigation (list ↔ editor ↔ share) resolves correctly once mounted under
// that prefix — per the plan's federation contract:
//
//   estimai-ui (remote)
//     exposes:  ./App   # root component; inner TanStack Router with
//                        # basepath '/estimai'; no auth guard, no chrome
//
// T13 (specs/003-suite-shell/tasks.md, AC-2.3): the router's own `_authed`
// guard is gone — the shell's guard (shell/src/router.tsx, T9) already
// resolves the session before this component is ever mounted (see
// src/router.tsx's file-level doc for the full rationale).
//
// T14 (specs/003-suite-shell/tasks.md, AC-4.2): the suite-level chrome
// (logo/About, avatar menu + sign-out, theme toggle) has been removed from
// estimai-ui's own components — the shell now owns it exclusively. Only
// tool-scoped chrome (project name, save-status, "My Estimates") remains.
export default function App() {
  const [mount] = useState(ownRouterMount)
  const own = useSyncExternalStore(mount.subscribe, mount.getCurrent)
  return own ? <RouterProvider key={own.key} router={own.router} /> : null
}

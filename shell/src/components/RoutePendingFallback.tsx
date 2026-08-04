/**
 * RoutePendingFallback — the router's content-area pending fallback (QE fix,
 * specs/012-employee-address: extracted out of `router.tsx`).
 *
 * Shown ONLY while an app-switch (or cold-cache) tool route's `beforeLoad` is
 * awaiting its Promise (`createToolAccessBeforeLoad` → `revalidatePermissions()`
 * → `GET /authz/me`, ~1s) — same-app inner-route navigation resolves that same
 * `beforeLoad` synchronously (see `createToolAccessBeforeLoad`'s doc in
 * `router.tsx`) and therefore never triggers this fallback at all. On a
 * genuine app switch, without this fallback TanStack Router would keep the
 * OUTGOING remote mounted during that window — and that remote's inner
 * router, now seeing the new (cross-basepath) URL, would render its own "Not
 * Found" until the new route resolves. `router.tsx` sets
 * `defaultPendingMs: 0` so this shows immediately on an app-switch navigation,
 * meaning the stale remote is never displayed mid-switch; the shell chrome
 * (header/sidebar/footer) stays mounted since only the tool-route child is
 * pending.
 *
 * This lives in its own file — not inlined in `router.tsx` — because
 * `router.tsx` exports route/router CONFIGURATION objects (`routeTree`,
 * `router`), not components; co-locating a component there tripped
 * `react-refresh/only-export-components` (Fast Refresh can't safely handle a
 * module that mixes component and non-component exports). Pre-existing on
 * `main` (confirmed present at `98267d0^`, before this feature), fixed here
 * with the user's explicit approval — properly, by moving the component out,
 * rather than suppressing the rule with a disable comment.
 */
export function RoutePendingFallback() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 py-16"
      data-testid="route-pending"
    >
      <div
        aria-hidden="true"
        className="h-8 w-8 animate-spin rounded-full border-2 border-rule border-t-acc"
      />
      <p className="sr-only" aria-live="polite">
        Loading…
      </p>
    </div>
  )
}

export default RoutePendingFallback

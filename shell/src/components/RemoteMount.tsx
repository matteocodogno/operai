/**
 * RemoteMount — the content-area remote boundary (specs/003-suite-shell, T11,
 * AC-6.1, US-6).
 *
 * A reusable wrapper that mounts a lazily-loaded federated remote's exposed root
 * component and handles its load lifecycle *within the content area only*:
 *
 *   - **Loading** — while the remote's `remoteEntry.js` / exposed module resolves,
 *     shows a scoped, content-area-only loading treatment (a React Suspense
 *     fallback) with a polite `aria-live` announcement, mirroring the existing
 *     `EstimatesPage` pattern (`<p className="sr-only" aria-live="polite">Loading
 *     your estimates</p>`) rather than inventing a new async-state convention.
 *   - **Failed** — if the remote fails to load (network error fetching
 *     `remoteEntry.js`, an MF runtime error, or the exposed module rejecting), shows
 *     an in-place `role="alert"` error confined to the content area, plus a Retry
 *     action. Visual language matches the existing alert idiom used by
 *     `ToastBanner`/`EstimatesPage` (`border-org`/`bg-org/10`/`text-org`, a bordered
 *     "Retry" button) — not those components reused verbatim (they're page-level;
 *     this is federation-boundary-level), per design.md's Screens & states note.
 *
 * The chrome (header/sidebar/footer, T5/T6/T7/T8) and the ability to switch to
 * another tool are NEVER affected by this component — RemoteMount only ever
 * renders inside the shell's `<main>` content region (see ShellLayout), so a
 * failure here can only ever replace the content area's own subtree.
 *
 * Parameterized by a `loader` thunk — the same shape `React.lazy()` expects
 * (`() => Promise<{ default: ComponentType<P> }>`) — rather than a hardcoded
 * `import('remote/Module')` call, so T9 can reuse this one boundary for both the
 * `/estimai` and `/refund` routes by passing each route's own dynamic import.
 *
 * Retry mechanics: `React.lazy()` memoizes the promise returned by the *first*
 * call to its thunk — re-rendering the same `lazy()`-wrapped component after a
 * rejection just re-throws the cached rejection, it does not re-invoke `loader`.
 * To make Retry actually re-attempt the load, this component keys an `attempt`
 * counter that (a) feeds a `useMemo` that calls `lazy(loader)` again — a fresh
 * `lazy()` instance whose thunk has not run yet, so `loader` really is invoked
 * again — and (b) is used as the `key` on the error boundary, so React discards
 * the old boundary (and its `hasError` state) and mounts an entirely fresh one
 * instead of requiring a second, separate "reset" code path.
 */
import { Component, Suspense, lazy, useCallback, useMemo, useState, type ComponentType, type ReactNode } from 'react'

export interface RemoteMountProps<P extends object = Record<string, never>> {
  /**
   * Loads the remote's exposed root component. Re-invoked from scratch on every
   * Retry (see module doc). Typically a dynamic import of a federated module,
   * e.g. `() => import('estimai/App')`.
   */
  loader: () => Promise<{ default: ComponentType<P> }>
  /**
   * Human-readable name of the tool/module being mounted, used in the loading
   * announcement and the error message (e.g. "EstimAI", "Refund").
   */
  moduleLabel: string
  /** Props forwarded to the mounted remote component once it resolves. */
  componentProps?: P
}

export function RemoteMount<P extends object = Record<string, never>>({
  loader,
  moduleLabel,
  componentProps,
}: RemoteMountProps<P>) {
  const [attempt, setAttempt] = useState(0)

  // A fresh `lazy()` call per attempt so `loader` truly re-runs on retry
  // instead of replaying a cached rejected promise (see module doc). `attempt`
  // is intentionally in the dep array purely to force recomputation on retry —
  // it is not read inside the memo callback itself, which `exhaustive-deps`
  // can't distinguish from an accidentally-unused dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` is a deliberate recompute trigger, not a stale-closure risk
  const LazyRemote = useMemo(() => lazy(loader), [loader, attempt])

  const retry = useCallback(() => setAttempt((current) => current + 1), [])

  return (
    <RemoteErrorBoundary key={attempt} moduleLabel={moduleLabel} onRetry={retry}>
      <Suspense fallback={<RemoteLoadingFallback moduleLabel={moduleLabel} />}>
        {/*
          `react-hooks/static-components` flags `LazyRemote` as "created during
          render" — true in the general case that rule guards against (a fresh
          component identity every render silently resets its own state), but
          here that's the deliberate mechanism, not a bug: `LazyRemote` is only
          ever recreated when `attempt` changes (see the `useMemo` above), i.e.
          exactly once per explicit Retry click, precisely so the freshly
          created `lazy()` re-invokes `loader` (see module doc "Retry
          mechanics"). There is no supported public API to reset an already-
          rejected `React.lazy()` promise, so a new `lazy()` instance per retry
          is the standard workaround for this pattern.
        */}
        {/* eslint-disable-next-line react-hooks/static-components -- intentional: see comment above */}
        <LazyRemote {...(componentProps as P)} />
      </Suspense>
    </RemoteErrorBoundary>
  )
}

function RemoteLoadingFallback({ moduleLabel }: { moduleLabel: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16" data-testid="remote-mount-loading">
      <div aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-rule border-t-acc" />
      {/* Announcement-only: mirrors EstimatesPage's `aria-live="polite"` sr-only
          loading text convention rather than a new async-state pattern. */}
      <p className="sr-only" aria-live="polite">{`Loading ${moduleLabel}…`}</p>
    </div>
  )
}

function RemoteErrorFallback({ moduleLabel, onRetry }: { moduleLabel: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-center px-6 py-16" data-testid="remote-mount-error">
      <div
        role="alert"
        className="flex max-w-md items-center justify-between gap-4 rounded-md border border-org/40 bg-org/10 px-4 py-3 text-sm text-org"
      >
        <span>{`${moduleLabel} couldn't load. Check your connection and try again.`}</span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 border border-org/60 px-2.5 py-1 text-xs font-medium text-org transition-colors hover:bg-org/20"
        >
          Retry
        </button>
      </div>
    </div>
  )
}

interface RemoteErrorBoundaryProps {
  children: ReactNode
  moduleLabel: string
  onRetry: () => void
}

interface RemoteErrorBoundaryState {
  hasError: boolean
}

/**
 * Minimal local error boundary — a React error boundary must be a class
 * component; per the project's no-extra-deps posture (CLAUDE.md, and the T2
 * precedent) this is hand-rolled rather than pulling in `react-error-boundary`.
 *
 * Catches both render-time errors from the mounted remote AND the rejection
 * `React.lazy()` re-throws on render once its promise has settled to rejected
 * (a network failure fetching `remoteEntry.js`, or an MF runtime error).
 */
class RemoteErrorBoundary extends Component<RemoteErrorBoundaryProps, RemoteErrorBoundaryState> {
  state: RemoteErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): RemoteErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    // Surfaced for observability; the in-place `role="alert"` UI (rendered
    // below) is the user-facing signal, this is the dev one — mirrors
    // SeedProbeMount's console usage (no `no-console` lint rule is configured).
    console.error(`[RemoteMount] failed to load remote module "${this.props.moduleLabel}"`, error)
  }

  render() {
    if (this.state.hasError) {
      return <RemoteErrorFallback moduleLabel={this.props.moduleLabel} onRetry={this.props.onRetry} />
    }
    return this.props.children
  }
}

export default RemoteMount

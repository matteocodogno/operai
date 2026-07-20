import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'

/**
 * NewRequestPage — `/refund/requests/new` (T16, specs/007-refund-service/
 * tasks.md, design.md F1 step 1: "`/refund/requests/new` immediately calls
 * `POST /requests` (no body) and redirects to `/refund/requests/$id` on
 * success … A brief centered spinner covers the round trip; on failure, an
 * inline message with 'Try again' / 'Back to my requests'").
 *
 * A component-level effect (not a router loader) — a loader has no natural
 * place to render this retry UI, and design.md is explicit this route's own
 * job is create-then-redirect, not a form of its own. `attempt` re-triggers
 * the effect for "Try again" without duplicating the create call inline.
 *
 * Bug fix (double-create on StrictMode double-invoke): React StrictMode
 * mounts, unmounts, then remounts a component's effects on the same
 * instance in dev — the previous `cancelled` flag only suppressed the
 * post-unmount *state update* of the first run, not the `create()` network
 * POST itself, so two `POST /requests` fired and two drafts were created.
 * `firedForAttempt` records the last `attempt` value the effect has already
 * fired `create()` for; the StrictMode remount sees the same `attempt` and
 * is a no-op, while a real "Try again" click (which bumps `attempt`) still
 * fires exactly once.
 */

type CreateState = { status: 'creating' } | { status: 'error'; message: string }

export default function NewRequestPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<CreateState>({ status: 'creating' })
  const [attempt, setAttempt] = useState(0)
  const firedForAttempt = useRef<number | null>(null)
  // Cancellation lives in a ref (not a per-invocation closure variable) so
  // that StrictMode's phantom "cleanup" of the first invocation — which
  // runs synchronously before the second, no-op invocation for the same
  // `attempt` — can be un-done by that second invocation. Without this, the
  // in-flight `create()` call started by the first invocation would resolve
  // with `cancelled` stuck `true` forever and silently never navigate.
  const cancelled = useRef(false)
  const t = strings.pages.newRequest

  useEffect(() => {
    if (firedForAttempt.current === attempt) {
      // StrictMode's remount of the same logical attempt: the create() call
      // is already in flight from the first invocation. Un-cancel it and
      // register a cleanup so a genuine later unmount still cancels it.
      cancelled.current = false
      return () => {
        cancelled.current = true
      }
    }
    firedForAttempt.current = attempt
    cancelled.current = false

    Promise.resolve()
      .then(() => {
        if (!cancelled.current) setState({ status: 'creating' })
      })
      .then(() => requestsApi.create())
      .then((created) => {
        if (cancelled.current) return
        void navigate({ to: '/requests/$id', params: { id: created.id }, replace: true })
      })
      .catch((error: unknown) => {
        if (cancelled.current) return
        const message = error instanceof ApiError ? (error.detail ?? error.title) : t.createError
        setState({ status: 'error', message })
      })

    return () => {
      cancelled.current = true
    }
  }, [attempt, navigate, t.createError])

  return (
    <section aria-labelledby="refund-new-request-heading" data-testid="refund-new-request-page">
      <h2 id="refund-new-request-heading" className="sr-only">
        {t.heading}
      </h2>

      {state.status === 'creating' && (
        <div className="flex flex-col items-center gap-3 py-16" role="status" data-testid="new-request-spinner">
          <span
            className="inline-block w-6 h-6 border-2 rounded-full animate-spin motion-reduce:animate-none"
            style={{ borderColor: 'var(--acc)', borderTopColor: 'transparent' }}
            aria-hidden="true"
          />
          <p className="sr-only" aria-live="polite">
            {t.creatingAnnouncement}
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          data-testid="new-request-error"
          className="flex flex-col items-center gap-3 py-16 text-center"
        >
          <p className="text-sm" style={{ color: 'var(--org)' }}>
            {state.message}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              data-testid="new-request-try-again"
              className="text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {t.tryAgain}
            </button>
            <Link
              to="/requests"
              data-testid="new-request-back-link"
              className="text-sm py-1.5 px-3 font-medium border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              {t.backToMyRequests}
            </Link>
          </div>
        </div>
      )}
    </section>
  )
}

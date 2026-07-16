import { useEffect, useState } from 'react'
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
 */

type CreateState = { status: 'creating' } | { status: 'error'; message: string }

export default function NewRequestPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<CreateState>({ status: 'creating' })
  const [attempt, setAttempt] = useState(0)
  const t = strings.pages.newRequest

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'creating' })
      })
      .then(() => requestsApi.create())
      .then((created) => {
        if (cancelled) return
        void navigate({ to: '/requests/$id', params: { id: created.id }, replace: true })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof ApiError ? (error.detail ?? error.title) : t.createError
        setState({ status: 'error', message })
      })

    return () => {
      cancelled = true
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

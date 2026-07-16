import { strings } from '../strings'

/**
 * NewRequestPage — `/refund/requests/new` placeholder (T14,
 * specs/007-refund-service/tasks.md).
 *
 * design.md's F1 step 1 gives this route real behavior later (T16): an
 * immediate `POST /requests` + redirect to `/refund/requests/$id`, with no
 * form of its own. T14 deliberately does NOT implement that call — it only
 * reserves the route and renders a placeholder, per this task's explicit
 * scope boundary ("scaffold routes with placeholder screens, don't build the
 * real UIs").
 */
export default function NewRequestPage() {
  return (
    <section aria-labelledby="refund-new-request-heading" data-testid="refund-new-request-page">
      <h2 id="refund-new-request-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.newRequest.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.newRequest.placeholder}
      </p>
    </section>
  )
}

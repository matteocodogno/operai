import { getRouteApi } from '@tanstack/react-router'
import { strings } from '../strings'

const route = getRouteApi('/review/$id')

/**
 * ReviewDetailPage — Screen A2 ("Review detail & decide", `/refund/review/$id`)
 * placeholder (T14, specs/007-refund-service/tasks.md). The real screen —
 * full line detail, download-only attachments, approved-total inputs,
 * Approve/Reject — is T18. This task ships only the route + a minimal
 * placeholder, proving the `$id` param resolves.
 */
export default function ReviewDetailPage() {
  const { id } = route.useParams()

  return (
    <section aria-labelledby="refund-review-detail-heading" data-testid="refund-review-detail-page">
      <h2
        id="refund-review-detail-heading"
        className="text-lg font-semibold"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {strings.pages.reviewDetail.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.reviewDetail.placeholder}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }} data-testid="refund-review-detail-id">
        {id}
      </p>
    </section>
  )
}

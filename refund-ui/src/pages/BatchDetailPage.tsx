import { getRouteApi } from '@tanstack/react-router'
import { strings } from '../strings'

const route = getRouteApi('/batches/$id')

/**
 * BatchDetailPage — Screen B3 ("Batch detail", `/refund/batches/$id`)
 * placeholder (T9, specs/008-refund-monthly-processing/tasks.md: "scaffold
 * routes with placeholders"). Also the eventual email deep-link landing page
 * (design.md F2/F3).
 *
 * The real screen (header, per-employee/per-currency groups, PDF download,
 * email status + resend, mark-as-paid, discard, status-driven variants —
 * design.md F2/F3/F4/F6) is T12 — this task ships only the route + a minimal
 * placeholder, proving the `$id` param resolves (mirrors T14's own
 * `RequestDetailPage`/`ReviewDetailPage` placeholder pattern, specs/007).
 */
export default function BatchDetailPage() {
  const { id } = route.useParams()

  return (
    <section aria-labelledby="refund-batch-detail-heading" data-testid="refund-batch-detail-page">
      <h2 id="refund-batch-detail-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.batchDetail.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.batchDetail.placeholder}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }} data-testid="refund-batch-detail-id">
        {id}
      </p>
    </section>
  )
}

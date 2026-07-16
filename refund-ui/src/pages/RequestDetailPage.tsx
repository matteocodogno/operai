import { getRouteApi } from '@tanstack/react-router'
import { strings } from '../strings'

const route = getRouteApi('/requests/$id')

/**
 * RequestDetailPage — Screen R2 (draft composer / request detail,
 * `/refund/requests/$id`) placeholder (T14, specs/007-refund-service/tasks.md).
 *
 * The real screen — four status-driven render variants (draft/submitted/
 * approved/rejected), the expense-line composer, attachments, subtotals,
 * submit/withdraw/delete — is T16/T17. This task ships only the route +
 * a minimal placeholder, proving the `$id` param resolves (mirrors
 * admin-ui/src/pages/RoleEditor.tsx's `getRouteApi('/roles/$id').useParams()`
 * convention).
 */
export default function RequestDetailPage() {
  const { id } = route.useParams()

  return (
    <section aria-labelledby="refund-request-detail-heading" data-testid="refund-request-detail-page">
      <h2
        id="refund-request-detail-heading"
        className="text-lg font-semibold"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {strings.pages.requestDetail.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.requestDetail.placeholder}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }} data-testid="refund-request-detail-id">
        {id}
      </p>
    </section>
  )
}

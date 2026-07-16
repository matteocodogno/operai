import { strings } from '../strings'

/**
 * ReviewQueuePage — Screen A1 ("Review queue", `/refund/review`) placeholder
 * (T14, specs/007-refund-service/tasks.md). The real screen — the
 * entity-scoped queue list + permission-denied state — is T18. This task
 * ships only the route + a minimal placeholder.
 */
export default function ReviewQueuePage() {
  return (
    <section aria-labelledby="refund-review-queue-heading" data-testid="refund-review-queue-page">
      <h2 id="refund-review-queue-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.reviewQueue.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.reviewQueue.placeholder}
      </p>
    </section>
  )
}

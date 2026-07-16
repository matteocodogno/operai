import { strings } from '../strings'

/**
 * MyRequestsPage — Screen R1 ("My requests", `/refund/requests`) placeholder
 * (T14, specs/007-refund-service/tasks.md: "each rendering a minimal
 * placeholder for now"). The real screen (list, loading/empty/populated/
 * error/permission-denied states, "+ New request") is T16 — this task ships
 * only the route + a minimal placeholder it mounts into.
 */
export default function MyRequestsPage() {
  return (
    <section aria-labelledby="refund-my-requests-heading" data-testid="refund-my-requests-page">
      <h2 id="refund-my-requests-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.myRequests.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.myRequests.placeholder}
      </p>
    </section>
  )
}

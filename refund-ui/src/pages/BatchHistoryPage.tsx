import { strings } from '../strings'

/**
 * BatchHistoryPage — Screen B1 ("Batch history", `/refund/batches`)
 * placeholder (T9, specs/008-refund-monthly-processing/tasks.md: "scaffold
 * routes with placeholders"). The real screen (list of every batch
 * regardless of status, "+ Compile new batch", loading/empty/error/
 * permission-denied states — design.md F8) is T13 — this task ships only the
 * route + a minimal placeholder it mounts into, mirroring T14's own
 * `MyRequestsPage`/`ReviewQueuePage` placeholder pattern (specs/007).
 */
export default function BatchHistoryPage() {
  return (
    <section aria-labelledby="refund-batch-history-heading" data-testid="refund-batch-history-page">
      <h2 id="refund-batch-history-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.batchHistory.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.batchHistory.placeholder}
      </p>
    </section>
  )
}

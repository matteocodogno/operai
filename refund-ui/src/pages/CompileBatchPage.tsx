import { strings } from '../strings'

/**
 * CompileBatchPage — Screen B2 ("Compile & preview", `/refund/batches/new`)
 * placeholder (T9, specs/008-refund-monthly-processing/tasks.md: "scaffold
 * routes with placeholders"). The real screen (cutoff picker, candidate
 * preview via `GET /batches/candidates`, compile confirm, empty-set refusal
 * — design.md F1) is T11 — this task ships only the route + a minimal
 * placeholder it mounts into, mirroring T14's own placeholder pattern
 * (specs/007).
 */
export default function CompileBatchPage() {
  return (
    <section aria-labelledby="refund-compile-batch-heading" data-testid="refund-compile-batch-page">
      <h2 id="refund-compile-batch-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.pages.compileBatch.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.compileBatch.placeholder}
      </p>
    </section>
  )
}

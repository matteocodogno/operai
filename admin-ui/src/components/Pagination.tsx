/**
 * Pagination — shared paginated-list control (T15, specs/004-auth-roles-permissions,
 * design.md "Pagination control (shared within admin-ui)").
 *
 * Genuinely NEW primitive — design.md is explicit that no existing screen in
 * the repo paginates (`EstimatesPage`'s list is unpaginated), so there is no
 * pattern to port here. Built once, reused by the Users list (Screen C1,
 * `GET /admin/users`) and the Audit log (Screen D1) — both later tasks
 * (T20/T21) that consume this component rather than re-implement it.
 *
 * A11y (design.md "Accessibility — Data tables"):
 *   • Real `<button>`s for Previous/Next — never clickable `<div>`s.
 *   • `aria-disabled="true"` (not the native `disabled` attribute) at the
 *     bounds, so the control stays perceivable/focusable to assistive tech
 *     while activation is a no-op — mirrors the same "aria-disabled +
 *     explanation, not a bare CSS disabled state" posture design.md applies
 *     to the System-role Delete button.
 *   • `aria-live="polite"` region announcing "Showing X–Y of N" (and "Page N
 *     of M") on every page change, mirroring the existing
 *     `aria-live="polite"` loading-announcement convention (`EstimatesPage`,
 *     `RemoteMount`).
 *
 * Presentational: the caller (a later screen — Users list, Audit log) owns
 * the current page and re-fetches on `onPageChange`.
 */

export type PaginationProps = {
  /** Current 1-based page number. */
  page: number
  /** Number of items per page. */
  pageSize: number
  /** Total number of items across all pages. */
  total: number
  /** Called with the new 1-based page number when Previous/Next is activated. */
  onPageChange: (page: number) => void
}

export default function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(1, page), totalPages)

  const isFirstPage = currentPage <= 1
  const isLastPage = currentPage >= totalPages

  const rangeStart = total === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const rangeEnd = Math.min(currentPage * pageSize, total)

  const goToPrevious = () => {
    if (isFirstPage) return
    onPageChange(currentPage - 1)
  }

  const goToNext = () => {
    if (isLastPage) return
    onPageChange(currentPage + 1)
  }

  const statusText =
    total === 0
      ? `Page ${currentPage} of ${totalPages} — Showing 0 of 0`
      : `Page ${currentPage} of ${totalPages} — Showing ${rangeStart}–${rangeEnd} of ${total}`

  return (
    <nav
      aria-label="Pagination"
      data-testid="pagination"
      className="flex items-center justify-between gap-4 px-1 py-2"
    >
      <button
        type="button"
        onClick={goToPrevious}
        aria-disabled={isFirstPage}
        data-testid="pagination-previous"
        className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
        style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
      >
        Previous
      </button>

      <p aria-live="polite" className="text-xs" style={{ color: 'var(--soft)' }} data-testid="pagination-status">
        {statusText}
      </p>

      <button
        type="button"
        onClick={goToNext}
        aria-disabled={isLastPage}
        data-testid="pagination-next"
        className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
        style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
      >
        Next
      </button>
    </nav>
  )
}

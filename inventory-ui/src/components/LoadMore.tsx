/**
 * LoadMore — the "show the next page" control for a cursor-paged list (T26,
 * specs/015-hardware-inventory; design.md § NEW components: "admin-ui
 * `Pagination` is page-number + total based; the API is cursor-only
 * (`nextCursor`)").
 *
 * The page owns the cursor, the appended rows and the copy; this component owns
 * the accessibility contract of design.md § Accessibility (T1 list):
 *   - while a page loads the button is `aria-disabled` + `aria-busy`, NOT
 *     `disabled` — a disabled button drops focus to the body, and focus must
 *     stay on "Load more" — and clicks are ignored;
 *   - a polite, sr-only `role="status"` line carries `announcement` (the page
 *     composes "{n} more assets loaded"); it stays mounted after the last page
 *     so that final announcement is still read;
 *   - when there is no further page the button is removed (the page then moves
 *     focus to the last loaded row's link);
 *   - a failed load is an inline alert, and the button stays as the retry.
 */

export type LoadMoreProps = {
  /** True while the server has a `nextCursor`. */
  hasMore: boolean
  /** True while the next page is being fetched. */
  isLoading: boolean
  onLoadMore: () => void
  /** Button label, e.g. "Load more". Page-owned copy. */
  label: string
  /** Button label in flight, e.g. "Loading more…". */
  loadingLabel: string
  /** Text for the polite status line; '' or omitted announces nothing. */
  announcement?: string
  /** Why the last load failed; null or omitted = no error. */
  errorMessage?: string | null
  testId?: string
}

export default function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
  label,
  loadingLabel,
  announcement = '',
  errorMessage = null,
  testId = 'load-more',
}: LoadMoreProps) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2" data-testid={testId}>
      {errorMessage && (
        <p role="alert" className="text-sm" style={{ color: 'var(--org)' }}>
          {errorMessage}
        </p>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={() => {
            if (!isLoading) onLoadMore()
          }}
          aria-disabled={isLoading || undefined}
          aria-busy={isLoading || undefined}
          className="btn btn-secondary"
        >
          {isLoading ? loadingLabel : label}
        </button>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

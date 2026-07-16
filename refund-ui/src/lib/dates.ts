/**
 * dates — small display-formatting helpers for refund-ui (T16,
 * specs/007-refund-service/tasks.md). refund-api's contract carries every
 * timestamp as ISO 8601 (plan.md "## API contracts": "All timestamps ISO
 * 8601"; CLAUDE.md: "Dates and durations always in ISO 8601 in API
 * contracts; display formatting is a UI concern") — this file is that UI
 * concern's single home, so Screen R1's row list and Screen R2's detail
 * variants format dates identically rather than each re-deriving their own
 * `toLocaleDateString` call (mirrors `estimai-ui/src/pages/EstimatesPage.tsx`'s
 * own local `formatDate`, promoted to a shared lib since two screens need it
 * here, not one).
 */

/** Formats an ISO 8601 timestamp/date as e.g. "16 Jul 2026". Returns "—" for an unparseable input. */
export const formatDate = (iso: string): string => {
  try {
    const parsed = new Date(iso)
    if (Number.isNaN(parsed.getTime())) return '—'
    return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

/** Today's date as a `yyyy-mm-dd` string — the default value for a new expense line's Date field. */
export const todayIsoDate = (): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

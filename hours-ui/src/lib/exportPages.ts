/**
 * exportPages — the walk the export makes over the list (specs/029-time-tracking T30; plan § Export file; AC-4.6,
 * A11, AC-4.11).
 *
 * The file holds exactly the entries the view's filters match, so the export does not reuse the pages the screen
 * happened to load: it asks `GET /time-entries` again with the SAME filters, `limit=500` (the most hours-api
 * takes), each page by the cursor of the one before, until `nextCursor` is `null`. Nothing is sorted or summed:
 * the items come back in the list's order.
 *
 * It is all or nothing. A page that fails — a refusal (503 `host_unavailable` under a deal filter, AC-4.11), a
 * network failure, an abort — rejects the whole walk, so no file is ever made from the pages that did arrive: a
 * silently short export is worse than none (an export is never re-checked). The caller decides what a refusal
 * means to the person.
 *
 * A server that handed back a cursor it had already given would send the walk round for ever; it stops with an
 * error instead.
 */
import { listEntries } from './hoursApi'
import type { EntryFilters } from './hoursApi'
import type { TimeEntryView, Unavailable, UnavailableSource } from './hoursApi.types'
import { unavailableSources } from './names'

/** The largest page hours-api answers (plan § Entries, `limit` 1..500). */
export const EXPORT_PAGE_SIZE = 500

export type ExportedEntries = {
  /** Every entry of every page, in the order of the list. */
  items: TimeEntryView[]
  /** The sources any page could not ask (AC-4.7), each once, in the catalog's order. */
  unavailable: UnavailableSource[]
}

export const readAllEntries = async (
  filters: EntryFilters,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ExportedEntries> => {
  const items: TimeEntryView[] = []
  const unavailable: Unavailable[] = []
  const given = new Set<string>()
  let cursor: string | undefined

  for (;;) {
    const page = await listEntries(filters, { cursor, limit: EXPORT_PAGE_SIZE, signal })
    items.push(...page.items)
    unavailable.push(page.unavailable)
    if (page.nextCursor === null) break
    if (given.has(page.nextCursor)) throw new Error('The list gave a cursor it had already given.')
    given.add(page.nextCursor)
    cursor = page.nextCursor
  }

  return { items, unavailable: unavailableSources(...unavailable) }
}

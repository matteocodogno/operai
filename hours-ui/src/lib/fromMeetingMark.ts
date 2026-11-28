import type { TimeEntryView } from './hoursApi.types'

/**
 * The one rule of the "From meeting" mark (specs/20261112-meeting-hours AC-2.3 as changed, D67, A47; plan D-P5; design S1).
 *
 * An automatic entry shows the mark exactly while it is recorded on a meeting: its own, another one, or one since deleted
 * (`on.type` stays `meeting`; `visibility` only says whether the name may be shown). Moved to a project, a deal or other
 * work it shows none, and moved back onto a meeting it shows it again. `EntryRow` (the List and a table cell's entries) and
 * `EntriesTable` (Everyone's hours) both ask it, so the two screens cannot disagree about one entry.
 *
 * It is not the delete confirmation's rule: that sentence reads `origin === 'meeting'` alone and still shows for a moved
 * entry, because Operai will not record the entry again whatever it is on now (AC-2.7, D70). Two predicates, on purpose.
 *
 * Anything else renders no mark: a hand-made entry, an hours-api that sends no `origin` (read as `person`), and a view
 * with no `on` (`?.` — a malformed entry draws no mark rather than failing the screen it is listed on).
 */
export const showsFromMeetingMark = (entry: Pick<TimeEntryView, 'origin' | 'on'>): boolean =>
  entry.origin === 'meeting' && entry.on?.type === 'meeting'

/**
 * How a person is named, and the Person filter's options (specs/029-time-tracking T29; AC-4.8, AC-5.5; design
 * S4 "Filters card"). Pure, and shared by the three places that list a person — the Person filter, the
 * Person column of the entries and the person totals — so one account is never named two ways.
 *
 * The name is whatever `auth` resolved at the time of the read (ADR-0039), so a person renamed since shows
 * under the new name everywhere at once; nothing here stores or caches one. `auth` keeps no name for a
 * deactivated account and answers none for one it cannot resolve: both are words from the catalog, and the
 * deactivated one says so, because its hours are still counted.
 */
import type { Person, TotalsAnswer } from '../lib/hoursApi.types'
import { strings } from '../strings'

/** One choice of the Person filter: `id` is the user id the filter then sends as `userId`. */
export type PersonOption = { id: string; label: string }

/** A person as the screen names them: the resolved name, else "Unknown user"; "(deactivated)" for a closed account. */
export const personName = (name: string | null, status: Person['status']): string => {
  const known = name !== null && name.trim() !== '' ? name : strings.everyone.person.unknown
  return status === 'deleted' ? strings.everyone.person.deactivated(known) : known
}

/**
 * The options of the Person filter: the `person` groups of the totals, as the server sent them (complete,
 * never paged, by name). Only keyed groups are people; a merged group is not offered.
 */
export const personOptions = (answer: TotalsAnswer): PersonOption[] =>
  answer.groups.flatMap((group) =>
    group.kind === 'keyed' ? [{ id: group.key, label: personName(group.label, group.status ?? 'unknown') }] : [],
  )

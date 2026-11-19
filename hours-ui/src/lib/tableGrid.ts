/**
 * tableGrid — the table view's grid, folded from one complete read of a person's period (specs/20261116-record-hours-in-place
 * T8, T18; plan § `tableGrid`, decisions 1 and 8; ADR 20261116-week-view-sums-a-complete-read-in-the-browser). A pure
 * function: entries and the period's days in, rows × days out, no I/O, no state.
 */
import type { TimeEntryView, Visibility } from './hoursApi.types'
import type { DealChoice, MeetingChoice, ProjectChoice } from './searchers'

/**
 * What "Add hours" on a row sets in the entry dialog. This is `EntryPreset['on']` of plan § `EntryDialog`, declared
 * here, member for member, because `EntryPreset` is defined in `EntryDialogModel.ts` by another task (T1): the two
 * are structurally identical, so a `TableGridRow['preset']` is assignable to `EntryPreset['on']` as it is.
 */
export type TableGridRowPreset =
  | { kind: 'project'; project: ProjectChoice }
  | { kind: 'deal'; deal: DealChoice }
  | { kind: 'meeting'; meeting: MeetingChoice }
  | { kind: 'none'; categoryId: string | null }

/** One day of one row: the entries on that row and day, as the server sent them, and their total. */
export type TableGridCell = { minutes: number; entries: TimeEntryView[] }

export type TableGridRow = {
  /** `project:<id>` | `deal:<id>` | `meeting:<id>` | `category:<id>`; `<kind>:unknown` for entries with no id. Never shown. */
  key: string
  kind: 'project' | 'deal' | 'meeting' | 'none'
  /** `null`: not readable (`visibility` is `hidden` or `unavailable`). A category's name for `none`. */
  name: string | null
  /** `visible` for a category. */
  visibility: Visibility
  /** A category's; `false` otherwise. */
  retired: boolean
  /** What Add hours sets; `null` for a row with no name and for a retired category (AC-5.24, D12). */
  preset: TableGridRowPreset | null
  /** Key: `YYYY-MM-DD`, a day of the grid's `days`; only the days that hold entries. */
  cells: Readonly<Record<string, TableGridCell>>
  minutes: number
}

export type TableGrid = {
  /** The period's days, as given: consecutive, ascending (seven, Monday to Sunday, for a week). */
  days: readonly string[]
  /** One for each of `days`; `0` for a day with nothing. */
  dayMinutes: readonly number[]
  rows: readonly TableGridRow[]
  totalMinutes: number
}

type Kind = TableGridRow['kind']

/** The kinds in the order the rows come (AC-5.8). */
const KIND_ORDER: readonly Kind[] = ['project', 'deal', 'meeting', 'none']

/**
 * The row an entry is on (AC-5.6, AC-5.7): its own project, deal, meeting or category and nothing else. A meeting
 * that counts for a deal is on the meeting's row, whatever `on.deal` says. An own entry always carries its target's id
 * (time-tracking D44); one that does not (defensive: a server that broke D44) goes to the kind's one `<kind>:unknown`
 * row, which has no name and offers no recording.
 */
const rowOf = (entry: TimeEntryView): { key: string; kind: Kind; id: string | null } => {
  const { on } = entry
  if (on.type === 'none') return { key: `category:${on.category.id}`, kind: 'none', id: on.category.id }
  return { key: `${on.type}:${on.id ?? 'unknown'}`, kind: on.type, id: on.id }
}

/**
 * What a row is called, whether its name may be shown and what "Add hours" sets, from the entries on it (AC-5.23,
 * AC-5.24). One rule, the list's: a name is shown only for `visibility: "visible"` with a label
 * (`names.ts` `rowName`), and a row that has none reads as the list reads an entry that has none — which the
 * screen draws, from `visibility`, as "Not visible to you" or "Name unavailable".
 *
 * A target has one visibility for one viewer, but the walk reads pages at different moments and a source can
 * answer on one page and not on the next, so the entries of one row may disagree. Then the row is `hidden` if any
 * entry says so (a name the server withheld is never shown), else it is named by the first entry that has a label.
 */
const summaryOf = (kind: Kind, id: string | null, entries: readonly TimeEntryView[]) => {
  const first = entries[0]!.on
  if (kind === 'none' && first.type === 'none') {
    const retired = entries.some((entry) => entry.on.type === 'none' && entry.on.category.retired)
    return {
      name: first.category.name,
      visibility: 'visible' as Visibility,
      retired,
      preset: retired ? null : ({ kind: 'none', categoryId: first.category.id } satisfies TableGridRowPreset),
    }
  }

  const named = entries.flatMap((entry) => (entry.on.type === 'none' ? [] : [entry.on]))
  const hidden = named.some((on) => on.visibility === 'hidden')
  const label = named.find((on) => on.visibility === 'visible' && on.label !== null)?.label ?? null
  const name = id !== null && !hidden ? label : null
  const visibility: Visibility = name !== null ? 'visible' : hidden ? 'hidden' : 'unavailable'
  return { name, visibility, retired: false, preset: id === null || name === null ? null : presetOf(kind, id, name) }
}

const presetOf = (kind: Kind, id: string, name: string): TableGridRowPreset | null => {
  switch (kind) {
    case 'project':
      return { kind: 'project', project: { id, name, companyName: null } }
    case 'deal':
      return { kind: 'deal', deal: { id, title: name, companyName: null } }
    case 'meeting':
      return { kind: 'meeting', meeting: { id, title: name, startsAt: null } }
    case 'none':
      return null
  }
}

/** Code-unit order of two texts: the same on every machine, for the tie-break nobody sees. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `Intl.Collator` for the language the shell set on `<html lang>`; the platform's own when there is none or it is no tag. */
const collatorOfPage = (): Intl.Collator => {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang
  try {
    return new Intl.Collator(lang || undefined, { sensitivity: 'base' })
  } catch {
    return new Intl.Collator(undefined, { sensitivity: 'base' })
  }
}

/**
 * The grid of a period: one row for each project, deal, meeting and category of other work the entries are on, a cell
 * for each day of the period they hold hours, and every total (row, day, period) summed over the one set given
 * (AC-5.6–5.10). `days` is the period's (`daysOf(period)`, consecutive and ascending: a caller bug otherwise, a
 * `TypeError`). Rows come projects, deals, meetings, other work; inside a kind the named ones by name (`<html lang>`,
 * case and accents ignored), then those with no name, then by key — so the order does not depend on the order the
 * entries came in (AC-5.8). An entry on a day outside `days` is a server bug (the read asked for the period): it throws
 * a `RangeError` naming the entry's id and day, never its note, so no figure is drawn from a set that is not the period's.
 */
export const tableGrid = (entries: readonly TimeEntryView[], days: readonly string[]): TableGrid => {
  if (days.length === 0 || days.some((day, index) => index > 0 && day <= days[index - 1]!)) {
    throw new TypeError('tableGrid: expected the consecutive, ascending days of a period')
  }
  const placeOf = new Map(days.map((day, index) => [day, index]))
  const dayMinutes = days.map(() => 0)
  const groups = new Map<string, { kind: Kind; id: string | null; entries: TimeEntryView[] }>()

  for (const entry of entries) {
    if (!placeOf.has(entry.day)) {
      throw new RangeError(
        `tableGrid: entry ${entry.id} is on ${entry.day}, outside the period ${days[0]} to ${days.at(-1)}`,
      )
    }
    const { key, kind, id } = rowOf(entry)
    const group = groups.get(key) ?? { kind, id, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }

  const rows = [...groups].map(([key, { kind, id, entries: onRow }]): TableGridRow => {
    const cells: Record<string, TableGridCell> = {}
    for (const entry of onRow) {
      const cell = (cells[entry.day] ??= { minutes: 0, entries: [] })
      cell.minutes += entry.minutes
      cell.entries.push(entry)
      dayMinutes[placeOf.get(entry.day)!]! += entry.minutes
    }
    const minutes = Object.values(cells).reduce((sum, cell) => sum + cell.minutes, 0)
    return { key, kind, ...summaryOf(kind, id, onRow), cells, minutes }
  })

  const collator = collatorOfPage()
  rows.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      Number(a.name === null) - Number(b.name === null) ||
      (a.name !== null && b.name !== null ? collator.compare(a.name, b.name) : 0) ||
      compareText(a.key, b.key),
  )

  return { days, dayMinutes, rows, totalMinutes: dayMinutes.reduce((sum, minutes) => sum + minutes, 0) }
}

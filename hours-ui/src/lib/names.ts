/**
 * names — what the screen says about a name it may or may not show (specs/029-time-tracking T25; AC-4.10,
 * AC-4.7, AC-2.6, AC-2.9; design S1 "Names the viewer cannot read").
 *
 * One rule under every function: a name (a project, a deal, a meeting, an activity's subject) is shown only
 * for `visibility: "visible"`. Anything else is a placeholder from the catalog (`strings.names`, shared with
 * the export), and a placeholder never carries the server's label, subject or an id — so a server that
 * wrongly sent one with a hidden record cannot make the screen show it. No function here returns an id.
 */
import { strings } from '../strings'
import type { EntryOn, TimeEntryView, TotalsAnswer, Unavailable, UnavailableSource } from './hoursApi.types'

/** A name to show, and the link it opens — only a visible name has one. */
export type ShownName = { text: string; href: string | null }

/**
 * `href` when it is a path inside the suite (`/projects/<id>`, `/crm/deals/<id>`, `/my-meetings/m/<id>`,
 * plan § Views), else `null`. A link is built from what the server sent, so only a rooted path is accepted:
 * never a scheme (`javascript:`), a host (`https://…`, `//host`) or a backslash that a browser reads as one.
 */
export const suitePath = (href: string | null | undefined): string | null =>
  typeof href === 'string' && /^\/(?![/\\])/.test(href) ? href : null

/** The kinds of entry that are on an entity (a project, a deal or a meeting) and so have a name. */
type Named = Exclude<EntryOn, { type: 'none' }>

/**
 * The name of a project, a deal or a meeting as the viewer may show it: the label with the API's link when
 * visible; "Not visible to you" when the viewer may not read it; "Name unavailable" when its owner did not
 * answer, and also when a visible one arrived without a label (an id is never the fallback). Other work has
 * no name — its category is the details line — so `null`.
 */
export const rowName = (on: EntryOn): ShownName | null => {
  if (on.type === 'none') return null
  return namedShown(on)
}

const namedShown = (on: Named): ShownName => {
  if (on.visibility === 'hidden') return { text: strings.names.hidden, href: null }
  if (on.visibility === 'unavailable' || on.label === null) return { text: strings.names.unavailable, href: null }
  return { text: on.label, href: suitePath(on.href) }
}

/**
 * A meeting row's "Counts for deal …" line (AC-2.6): the deal its hours count for, or why the viewer is not
 * told. `null` for a meeting linked to no deal (nothing to say) and for every kind that is not a meeting.
 */
export const countsForDealLine = (on: EntryOn): string | null => {
  if (on.type !== 'meeting') return null
  const { deal } = on
  switch (deal.state) {
    case 'none':
      return null
    case 'unknown':
      return strings.names.countsForUnknownDeal
    case 'linked':
      if (deal.visibility === 'visible') return strings.names.countsForDeal(deal.label)
      return deal.visibility === 'hidden' ? strings.names.countsForHiddenDeal : strings.names.countsForUnavailableDeal
  }
}

/** The "Activity: …" line (AC-2.7): `null` when the entry points at none or at one deleted since (AC-2.9). */
export const activityLine = (activity: TimeEntryView['activity']): string | null => {
  if (activity === null) return null
  if (activity.visibility === 'hidden') return strings.names.activityHidden
  if (activity.visibility === 'unavailable' || activity.subject === null) return strings.names.activityUnavailable
  return strings.names.activity(activity.subject)
}

/**
 * How the entry is named in the label of its Edit and Delete buttons ("Edit 4 h on Project Alpha, …"): the
 * name when the viewer may read it, else the kind of record and why the name is withheld. Two hidden rows of
 * one day are told apart only by duration and position — the screen has no id for a hidden record.
 */
export const onPhrase = (on: EntryOn): string => {
  if (on.type === 'none') return strings.entries.onPhrase.none(on.category.name)
  if (on.visibility === 'hidden') return strings.entries.onPhrase[on.type].hidden
  if (on.visibility === 'unavailable' || on.label === null) return strings.entries.onPhrase[on.type].unavailable
  return on.label
}

const isHidden = (visibility: string) => visibility === 'hidden'

const entryHasHiddenName = (entry: TimeEntryView): boolean =>
  (entry.on.type !== 'none' && isHidden(entry.on.visibility)) ||
  (entry.on.type === 'meeting' && entry.on.deal.state === 'linked' && isHidden(entry.on.deal.visibility)) ||
  (entry.activity !== null && isHidden(entry.activity.visibility))

/**
 * Whether anything the viewer sees is withheld because they may not read it (AC-4.10): an entry's project,
 * deal or meeting, the deal a meeting counts for, an activity, or a `hidden` group of the totals. Only then
 * does the standing "names not visible" note show. An UNAVAILABLE name is another thing (the owner did not
 * answer) and has its own banner.
 */
export const hasHiddenName = (items: readonly TimeEntryView[], totals?: TotalsAnswer | null): boolean =>
  items.some(entryHasHiddenName) || (totals?.groups.some((group) => group.kind === 'hidden') ?? false)

/** The sources a name could not be read from, in the fixed order of the catalog, each once. */
const SOURCE_ORDER: readonly UnavailableSource[] = [
  'identities',
  'projects',
  'crm',
  'activities',
  'meetings',
  'meeting-deals',
]

/** The union of what each read said it could not ask — the sources the "names could not be loaded" banner names. */
export const unavailableSources = (...answers: (Unavailable | undefined)[]): UnavailableSource[] => {
  const asked = new Set(answers.flatMap((answer) => answer ?? []))
  return SOURCE_ORDER.filter((source) => asked.has(source))
}

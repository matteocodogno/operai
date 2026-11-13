/**
 * The rows of the Totals table, from the server's groups (specs/029-time-tracking T24; plan § Totals,
 * design S1 "Totals" and "Names the viewer cannot read").
 *
 * Pure: one row per group, IN THE ORDER THE SERVER SENT THEM — never sorted here, because the plan fixes
 * that order per grouping (minutes descending, then the merged rows; months newest first) and a second
 * sort would only be able to disagree with it. A merged group (`hidden`, `unavailable`, `deal-unknown`,
 * `none`) is the row the server made of it: one row however many items it holds. Names of the data (a
 * project, a deal, a category) are shown as the server sends them; the words around them come from the
 * catalog, and no row ever shows an id. A person is named as everywhere else (`personName`, T29): "Unknown
 * user" when the name could not be read, "(deactivated)" for a closed account.
 */
import { formatMonth } from '@operai/ui'
import type { TotalsGroup } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { personName } from './PersonFilterOptions'

/** The groupings My hours offers. Day only labels the entries, and Person is Everyone's hours' (below). */
export const GROUP_CHOICES = ['project', 'deal', 'category', 'month'] as const

/** Everyone's hours (T29) adds Person, first, and groups by it by default. */
export const EVERYONE_GROUP_CHOICES = ['person', ...GROUP_CHOICES] as const
export type GroupChoice = (typeof EVERYONE_GROUP_CHOICES)[number]

export type TotalsRow = { key: string; label: string; minutes: number }

/** The words of each merged kind, per grouping. A kind the grouping has no words for is "Other hours". */
const mergedWords = (): Record<GroupChoice, Partial<Record<string, string>>> => {
  const rows = strings.totals.rows
  return {
    // A person is never merged: every group of the person grouping is a keyed one.
    person: {},
    project: { hidden: rows.project.hidden, unavailable: rows.project.unavailable, none: rows.project.none },
    deal: {
      hidden: rows.deal.hidden,
      unavailable: rows.deal.unavailable,
      'deal-unknown': rows.deal.dealUnknown,
      none: rows.deal.none,
    },
    category: { none: rows.category.none },
    month: {},
  }
}

/** `YYYY-MM` in the person's language; a key that is not one (a contract slip) is shown as sent, never a crash. */
const monthLabel = (key: string): string => {
  try {
    return formatMonth(key)
  } catch {
    return key
  }
}

export const totalsRows = (groupBy: GroupChoice, groups: readonly TotalsGroup[]): TotalsRow[] => {
  const words = mergedWords()[groupBy]
  return groups.map((group, index): TotalsRow => {
    if (group.kind !== 'keyed') {
      return {
        key: `${group.kind}:${index}`,
        label: words[group.kind] ?? strings.totals.rows.other,
        minutes: group.minutes,
      }
    }
    if (groupBy === 'person') {
      return {
        key: `keyed:${group.key}`,
        label: personName(group.label, group.status ?? 'unknown'),
        minutes: group.minutes,
      }
    }
    const name = groupBy === 'month' ? monthLabel(group.key) : (group.label ?? strings.totals.nameUnavailable)
    return {
      key: `keyed:${group.key}`,
      label: groupBy === 'category' && group.retired === true ? strings.totals.retired(name) : name,
      minutes: group.minutes,
    }
  })
}

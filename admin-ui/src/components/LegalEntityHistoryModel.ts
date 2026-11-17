/**
 * LegalEntityHistoryModel — the small pure decisions of the History view (T39, specs/20261117-legal-entities,
 * design S5–S7): which version is current, which values make a restore impossible, and which values a restore
 * changes. Nothing here judges a value (plan decision 10): `restorable`, `complete`, `missing` and `invalid` are
 * the registry's own words; this file only orders and names them.
 */
import { FIELD_PAGE_ORDER, changedFieldsBetween } from '../lib/legalEntityModel'
import type {
  LegalEntity,
  LegalEntityDetails,
  LegalEntityField,
  LegalEntityProblem,
  VersionListItem,
} from '../lib/legalEntityModel'

/** The versions newest first, whatever order they came in. Does not mutate its argument. */
export const newestFirst = (items: readonly VersionListItem[]): VersionListItem[] =>
  [...items].sort((a, b) => b.version - a.version)

/** The highest version of the list: the one in effect. `undefined` for an empty list. */
export const latestVersion = (items: readonly VersionListItem[]): number | undefined =>
  items.length === 0 ? undefined : Math.max(...items.map((item) => item.version))

/** Each field once, in the order of the controls on the page. */
const inPageOrder = (fields: readonly LegalEntityField[]): LegalEntityField[] =>
  FIELD_PAGE_ORDER.filter((field) => fields.includes(field))

/**
 * The values that stop a version from being restored, from its own answer: what is missing (`complete: false`)
 * and what is out of rule (`invalid`). Empty when the version passes today's rules.
 */
export const blockingFields = (version: Pick<LegalEntity, 'complete' | 'missing' | 'invalid'>): LegalEntityField[] =>
  inPageOrder([...(version.complete ? [] : version.missing), ...version.invalid.map((problem) => problem.field)])

/** The values a refused restore (422 `problems[]`) names, once each, in page order. */
export const refusedFields = (problems: readonly LegalEntityProblem[]): LegalEntityField[] =>
  inPageOrder(problems.map((problem) => problem.field))

/** The values a restore would change: those of the version to restore that differ from the current details. */
export const restoreChanges = (target: LegalEntityDetails, current: LegalEntityDetails): LegalEntityField[] =>
  inPageOrder(changedFieldsBetween(target, current))

/**
 * The words a row button shares with its accessible name: "Open version" of "Open version 3". The strings carry the
 * names ("Open version n", "Restore version n") but not the bare visible words of the buttons, so the visible text
 * is what every row's name has in common. It is also always contained in the name (WCAG 2.5.3, label in name),
 * in both languages. When the strings gain `history.openLabel` / `history.restoreLabel`, use them instead.
 */
export const sharedWords = (name: (n: number) => string): string => {
  const a = name(1)
  const b = name(2)
  let end = 0
  while (end < a.length && end < b.length && a[end] === b[end]) end += 1
  return a.slice(0, end).trim()
}

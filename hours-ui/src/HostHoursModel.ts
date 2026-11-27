/**
 * HostHoursModel — what the hours panel takes in and what it shows of an answer, apart from how it looks (specs/20261112-project-hours
 * T13; plan § API contracts "`hours/HostHours`", `SummaryAnswer`; design S3). A component file may export only components
 * (`react-refresh`), so this is its sibling.
 */
import { personName } from './components/PersonFilterOptions'
import type { SummaryAnswer, TotalsGroup } from './lib/hoursApi.types'
import { strings } from './strings'

/**
 * The two plain strings a host passes through the shell's `HostExtension` (extension `hours.hostHours`), and nothing else crosses the
 * seam (ADR 20261104-host-extension-federated-panel-through-the-shell). The shell's `ExtensionProps['hours.hostHours']` and the two
 * hosts' hand-kept copies say the same; this is the remote's own.
 */
export type HostHoursProps = {
  on: 'project' | 'deal'
  /** The project's or deal's id. */
  targetId: string
}

const KINDS: readonly string[] = ['project', 'deal']

/**
 * Returns the props when they are a project or a deal with its id, and throws otherwise (the `RecordHoursModel.checkProps` rule): an
 * invalid set is a host bug, which the host's boundary turns into its own fallback, never a read of nothing. The message names the rule
 * and never a value, so no id reaches a log.
 */
export const checkProps = (props: HostHoursProps): HostHoursProps => {
  const fail = (rule: string): never => {
    throw new Error(`HostHours: ${rule}`)
  }
  if (typeof props !== 'object' || props === null) return fail('no props were given')
  const given = props as Record<string, unknown>
  if (typeof given['on'] !== 'string' || !KINDS.includes(given['on'])) return fail('`on` is not project or deal')
  if (typeof given['targetId'] !== 'string' || given['targetId'].trim() === '') {
    return fail(`a ${given['on']} needs its \`targetId\``)
  }
  return props
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A whole number of minutes the screen can show: a finite number, never negative. */
const isMinutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

const isGroups = (value: unknown): value is TotalsGroup[] =>
  Array.isArray(value) &&
  value.every((group) => isRecord(group) && typeof group['kind'] === 'string' && isMinutes(group['minutes']))

/**
 * Whether `value` is an answer this panel can show (plan § `SummaryAnswer`): the total, the work-type groups, the person groups or
 * `null`, and the list of what could not be asked. Anything else is shown as an unavailable read, never as a figure: a total that is
 * missing or not a number must not read as "0 min", and the panel's promise is that no figure is better than one that could be wrong
 * (AC-4.9). Only what the panel renders is checked: a member it does not read (`on`, `windowMinutes`) and an unknown note do not matter.
 */
export const isSummaryAnswer = (value: unknown): value is SummaryAnswer =>
  isRecord(value) &&
  isMinutes(value['totalMinutes']) &&
  isGroups(value['byWorkType']) &&
  (value['byPerson'] === null || isGroups(value['byPerson'])) &&
  Array.isArray(value['unavailable'])

/** One row of a breakdown table. `key` is for React, never shown; `label` is a name or words from the catalog, never an id. */
export type BreakdownRow = { key: string; label: string; minutes: number }

const rowKey = (group: TotalsGroup, index: number): string =>
  group.kind === 'keyed' ? `keyed:${group.key}` : `${group.kind}:${index}`

/**
 * The rows of "By work type", one per group IN THE ORDER THE SERVER SENT THEM (minutes descending, "Without a work type" last): nothing is
 * summed or sorted here. A work type is shown as the server sends it, "(retired)" when it is; a group with no name reads "Name
 * unavailable" and never its key; the `none` group is the entries without a work type, the meetings' included; a kind this build has no
 * words for (a server one step ahead) is "Other hours", so its time is still shown.
 */
export const workTypeRows = (groups: readonly TotalsGroup[]): BreakdownRow[] =>
  groups.map((group, index): BreakdownRow => {
    const key = rowKey(group, index)
    if (group.kind === 'none') return { key, label: strings.hostHours.byWorkType.none, minutes: group.minutes }
    if (group.kind !== 'keyed') return { key, label: strings.totals.rows.other, minutes: group.minutes }
    const name = group.label ?? strings.totals.nameUnavailable
    return { key, label: group.retired === true ? strings.entries.retired(name) : name, minutes: group.minutes }
  })

/**
 * The rows of "By person", in the server's order (by name). A person is named as every other list names one (`personName`: "Unknown
 * user" when the name could not be read, "(deactivated)" for a closed account), so one account is never named two ways.
 */
export const personRows = (groups: readonly TotalsGroup[]): BreakdownRow[] =>
  groups.map((group, index): BreakdownRow => {
    const key = rowKey(group, index)
    if (group.kind !== 'keyed') return { key, label: strings.totals.rows.other, minutes: group.minutes }
    return { key, label: personName(group.label, group.status ?? 'unknown'), minutes: group.minutes }
  })

/**
 * What the answer says it could not ask (`SummaryAnswer.unavailable`): the names of the people (`identities`: their rows read "Unknown
 * user") and the per-person right (`authz`: `byPerson` is withheld, fail closed). Any other note is one this build does not know.
 */
export const notesOf = (answer: SummaryAnswer): { identities: boolean; authz: boolean } => ({
  identities: answer.unavailable.includes('identities'),
  authz: answer.unavailable.includes('authz'),
})

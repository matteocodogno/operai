/**
 * RecordHoursModel — what the Record hours button takes in and what it opens the dialog on, apart from how it looks
 * (specs/20261116-record-hours-in-place T2; plan § API contracts "`hours/RecordHours`" and "The shell's extension
 * `hours.recordHours`"). A component file may export only components (`react-refresh`), so this is its sibling.
 */
import type { EntryPreset } from './components/EntryDialogModel'

/**
 * The six plain strings a host passes through the shell's `HostExtension`, and nothing else crosses the seam
 * (ADR 20261104-host-extension-federated-panel-through-the-shell). The shell's `ExtensionProps['hours.recordHours']` and the two hosts' hand-kept
 * copies say the same; this is the remote's own.
 */
export type RecordHoursProps = {
  on: 'project' | 'deal' | 'none'
  /** The project or deal id; '' when `on` is 'none'. */
  targetId: string
  /** The target's name as the host shows it; '' when the host cannot name it, or `on` is 'none'. */
  targetName: string
  /** The task's id when recorded from a task row on a project or a deal; otherwise ''. */
  activityId: string
  /** The task's subject; '' when there is no task. With `on` 'none' it only names the button, and is never sent (G3). */
  activityName: string
  /** The page header's button, or a task row's smaller one. */
  placement: 'page' | 'row'
}

/** My hours' address: the message's link, a fixed path (never built from a prop) that goes through the shell's router. */
export const MY_HOURS_PATH = '/hours'

const KINDS: readonly string[] = ['project', 'deal', 'none']
const PLACEMENTS: readonly string[] = ['page', 'row']
const TEXT_MEMBERS = ['targetId', 'targetName', 'activityId', 'activityName'] as const

/**
 * Returns the props when they are one of the valid sets, and throws otherwise (plan § `hours/RecordHours`):
 *
 * - `on` a project or a deal, with a `targetId`, and `activityName` only with an `activityId`;
 * - `on` none, with `targetId`, `targetName` and `activityId` all empty (a CRM task about a company is recorded as
 *   other work, linked to no task), `activityName` free: it only names the button.
 *
 * An invalid set is a host bug, which the host's boundary turns into its fallback link: never a silent "record on
 * nothing". The message names the rule and never a value, so no name or id reaches a log.
 */
export const checkProps = (props: RecordHoursProps): RecordHoursProps => {
  const fail = (rule: string): never => {
    throw new Error(`RecordHours: ${rule}`)
  }
  if (typeof props !== 'object' || props === null) return fail('no props were given')
  const given = props as Record<string, unknown>
  if (typeof given['on'] !== 'string' || !KINDS.includes(given['on'])) return fail('`on` is not project, deal or none')
  if (typeof given['placement'] !== 'string' || !PLACEMENTS.includes(given['placement'])) {
    return fail('`placement` is not page or row')
  }
  for (const member of TEXT_MEMBERS) {
    if (typeof given[member] !== 'string') return fail(`\`${member}\` is not a string`)
  }

  const { on, targetId, targetName, activityId, activityName } = props
  if (on === 'none') {
    if (targetId !== '' || targetName !== '' || activityId !== '') {
      return fail('other work takes no target and no task (only `activityName`, to name the button)')
    }
  } else {
    if (targetId.trim() === '') return fail(`a ${on} needs its \`targetId\``)
    if (activityName !== '' && activityId === '') return fail('`activityName` is only given with an `activityId`')
  }
  return props
}

/**
 * What the dialog opens on, built from the one set the host passed (plan R10: the name shown and the id recorded on
 * come from the same object): the project or deal, and the task when there is one. Other work has no category
 * chosen (A3) and no task, whatever `activityName` says: it names the button, never the entry. The day is left out,
 * so the dialog opens on today.
 */
export const presetOf = (props: RecordHoursProps): EntryPreset => {
  const { on, targetId, targetName, activityId, activityName } = props
  if (on === 'none') return { on: { kind: 'none', categoryId: null } }
  const activity =
    activityId === '' ? {} : { activity: { id: activityId, subject: activityName === '' ? null : activityName } }
  return on === 'project'
    ? { on: { kind: 'project', project: { id: targetId, name: targetName, companyName: null } }, ...activity }
    : { on: { kind: 'deal', deal: { id: targetId, title: targetName, companyName: null } }, ...activity }
}

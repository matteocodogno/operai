/**
 * Record hours on a project's page and on a task's row (specs/20261116-record-hours-in-place US-1 and US-3, ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam).
 *
 * The widget is hours-ui's own, embedded through the shell's `hours.recordHours` extension; this module is the
 * host's half: WHETHER the page or the row offers it, and the six plain strings it is given. Both are a convenience
 * of the page, never an authority — hours-api asks the project's owner as the caller on every save and refuses with
 * `not_on_project` (specs/20261112-time-tracking, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). The rule is a pure
 * function of what the page or the row already holds and the person's id (D4, no new read).
 */
import type { ExtensionProps } from 'shell/extensions'
import type { MyTask } from './activitiesApi'
import type { Project } from './types'

/** The props the shell's `hours.recordHours` extension takes: plain strings, nothing comes back. */
export type RecordHoursProps = ExtensionProps['hours.recordHours']

/**
 * My hours, where the fallback link goes when the widget cannot be loaded (AC-4.5). A fixed path in the shell,
 * outside this remote's router basepath, so a plain `<a href>` and never a router link (`lib/links.ts`).
 */
export const MY_HOURS_HREF = '/hours'

/**
 * Whether the project page offers Record hours (AC-1.1, AC-1.2): the project's manager and the members of its
 * team. Anyone else who can read the project does not (AC-1.2); `false` too while the session has not given the
 * person's id yet (`me` is `null`) and for a project that awaits its manager (`projectManager` is `null`) — an
 * absent id never matches a present one. The project's state does not matter (A5).
 */
export const mayRecordOnProject = (project: Project, me: string | null): boolean =>
  me !== null && (project.projectManager?.id === me || project.team.some((member) => member.id === me))

/**
 * The props of the widget, built from the ONE object the host holds, never assembled at the call site, because the
 * widget shows the name and records on the id and cannot check they belong together (plan R10).
 *
 * - **A project** (its page, AC-1.1): the project and nothing else, the page's placement.
 * - **A task** (its row, AC-3.2 – AC-3.4), the row's placement: an operational task records on its project and
 *   on the task; a pre-sales task with a deal on that deal and the task; a pre-sales task with no deal as other
 *   work (`on: 'none'`, no id, no name), because hours-api accepts a task pointer only on a project or a deal
 *   (time-tracking AC-2.7) — its subject is then only the button's accessible name, never sent (plan amendment
 *   G3). The same for a done task as for an open one (AC-3.6): nothing reads `completedAt`.
 *
 * `null` for a task that names no project the widget could record on (an operational task whose project the
 * answer left out): the widget throws on an empty id, and "record on nothing" is never offered, so the row shows
 * no button. A pre-sales task with a deal that has no id is a task with no deal.
 */
export function recordHoursPropsOf(project: Project): RecordHoursProps
export function recordHoursPropsOf(task: MyTask): RecordHoursProps | null
export function recordHoursPropsOf(subject: Project | MyTask): RecordHoursProps | null {
  if (!('task' in subject)) {
    return {
      on: 'project',
      targetId: subject.id,
      targetName: subject.name,
      activityId: '',
      activityName: '',
      placement: 'page',
    }
  }
  const activity = { activityId: subject.id, activityName: subject.subject, placement: 'row' } as const
  if (subject.kind === 'operational') {
    const project = subject.project
    return project && project.id !== ''
      ? { on: 'project', targetId: project.id, targetName: project.name ?? '', ...activity }
      : null
  }
  const deal = subject.deal
  return deal && deal.id !== ''
    ? { on: 'deal', targetId: deal.id, targetName: deal.title ?? '', ...activity }
    : { on: 'none', targetId: '', targetName: '', activityId: '', activityName: subject.subject, placement: 'row' }
}

/**
 * Whether a task's row offers Record hours (AC-3.1, AC-3.6): the task's assignee and the colleagues who take part
 * in it. Its author alone is not offered it, and neither is anyone else who can read the task — such a person
 * records on the project from My hours. A task that is done offers it exactly as an open one does (A4): nothing
 * here reads `completedAt`, nor the row's `may` flags, which say what the person may do with the TASK (edit,
 * delete, complete) and not whether they spent time on it.
 *
 * `false` while the session has not given the person yet (`me` is `null`), and for an empty id: an absent id
 * never matches an absent assignee. Ids are compared whole. Only a convenience of the row — hours-api asks the
 * project's or the deal's owner as the caller on every save and refuses what the person may not record.
 */
export const mayRecordOnTask = (task: MyTask, me: string | null): boolean =>
  me !== null &&
  me !== '' &&
  (task.task.assignee?.id === me || (task.participants ?? []).some((participant) => participant.id === me))

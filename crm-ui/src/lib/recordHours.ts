/**
 * Record hours in place, the CRM host's half (specs/20261116-record-hours-in-place, ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam): who is offered the button, and the props the widget
 * gets. Both are pure functions of the object the page already holds.
 *
 * The rule only decides whether the button SHOWS. Whether the person may record is hours-api's answer to the save,
 * asked of the owner as the caller and failing closed (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route),
 * so a rule that is wrong in either direction costs a missing shortcut or a refused save, never a wrong entry.
 */
import type { ExtensionProps } from 'shell/extensions'
import type { Activity, Deal } from './types'

/** What the shell's `hours.recordHours` extension takes: six plain strings, nothing comes back. */
export type RecordHoursProps = ExtensionProps['hours.recordHours']

/**
 * A deal's page offers Record hours to its owner and to the technical contact of its estimate (D4). Anyone else who
 * can read the deal — including a person involved only through one of its tasks — records from My hours, or from the
 * task's own row (AC-2.2). `me` is null until the session has given the person's id: nothing is offered then.
 */
export function mayRecordOnDeal(deal: Deal, me: string | null): boolean {
  if (!me) return false
  return me === deal.owner.id || me === deal.estimate?.technical.id
}

/**
 * The widget's props for the deal's page header, built from ONE object so the name the person reads and the id the
 * hours are recorded on cannot come from two different deals (plan R10). Never assemble these at a call site.
 */
export function recordHoursPropsOfDeal(deal: Deal): RecordHoursProps {
  return {
    on: 'deal',
    targetId: deal.id,
    targetName: deal.title,
    activityId: '',
    activityName: '',
    placement: 'page',
  }
}

/**
 * A task's row offers Record hours to its assignee and to the people taking part in it (D4, AC-3.1): the person who only
 * wrote the task is not offered it, and neither is anyone else who can read it. A done task is offered exactly as an open
 * one (AC-3.6, A4): `completedAt` is not read. Only a task has hours to record, so a note, call, meeting or email never
 * does, whoever took part in it. `me` is null until the session has given the person's id: nothing is offered then.
 */
export function mayRecordOnTask(activity: Activity, me: string | null): boolean {
  if (!me || activity.task === null) return false
  return me === activity.task.assignee?.id || (activity.participants ?? []).some((person) => person.id === me)
}

/**
 * The widget's props for a task's row (plan decision 4, G3), built from ONE activity so the deal's name, the deal's id
 * and the task they belong to cannot come from two different rows (plan R10). Never assemble these at a call site.
 *
 * - A task about one of the company's deals records on that deal, pointing at the task (AC-3.3).
 * - A task about a company and no deal records as other work with nothing linked: hours-api accepts `activityId` only on
 *   a project or a deal, and the entry carries no link to the company, the contact or the task (AC-3.4, AC-3.5). The
 *   subject still goes across, to name the button "Record hours on <subject>" and nothing else (G3).
 *
 * Null for an activity that is not a task. It does not read `completedAt` (AC-3.6).
 */
export function recordHoursPropsOf(activity: Activity): RecordHoursProps | null {
  if (activity.task === null) return null
  if (activity.deal) {
    return {
      on: 'deal',
      targetId: activity.deal.id,
      targetName: activity.deal.title ?? '',
      activityId: activity.id,
      activityName: activity.subject,
      placement: 'row',
    }
  }
  return {
    on: 'none',
    targetId: '',
    targetName: '',
    activityId: '',
    activityName: activity.subject,
    placement: 'row',
  }
}

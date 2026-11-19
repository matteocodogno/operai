/**
 * strings — every user-facing string of projects-ui, in English and Italian
 * (AC-4.7). One file per namespace under `./strings/`, aggregated here;
 * components import `strings` and never inline copy
 * (`lib/noHardcodedStrings.test.ts` scans all of `src/`).
 *
 * `projects`, `project`, `terms` and `purchaseOrder` belong to the list, the
 * project page, the terms and the purchase order: each task fills its own file
 * and never edits this aggregator. `queue` is the to-start queue of specs/20261103-projects-handoff.
 */
import { selectStrings } from '@operai/ui'
import { badges } from './strings/badges'
import { common } from './strings/common'
import { nav } from './strings/nav'
import { people } from './strings/people'
import { project } from './strings/project'
import { projects } from './strings/projects'
import { tasks } from './strings/tasks'
import { purchaseOrder } from './strings/purchaseOrder'
import { queue } from './strings/queue'
import { recordHours } from './strings/recordHours'
import { terms } from './strings/terms'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  badges: badges.en,
  common: common.en,
  nav: nav.en,
  people: people.en,
  project: project.en,
  projects: projects.en,
  tasks: tasks.en,
  purchaseOrder: purchaseOrder.en,
  queue: queue.en,
  recordHours: recordHours.en,
  terms: terms.en,
}

/** The Italian catalog: typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  badges: badges.it,
  common: common.it,
  nav: nav.it,
  people: people.it,
  project: project.it,
  projects: projects.it,
  tasks: tasks.it,
  purchaseOrder: purchaseOrder.it,
  queue: queue.it,
  recordHours: recordHours.it,
  terms: terms.it,
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })

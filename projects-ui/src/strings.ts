/**
 * strings — every user-facing string of projects-ui, in English and Italian
 * (AC-4.7). One file per namespace under `./strings/`, aggregated here;
 * components import `strings` and never inline copy
 * (`lib/noHardcodedStrings.test.ts` scans all of `src/`).
 *
 * `projects`, `project` and `contracts` belong to the tasks that build the list
 * (T12), the project page (T13) and the contracts (T14): each fills its own file
 * and never edits this aggregator.
 */
import { selectStrings } from '@operai/ui'
import { badges } from './strings/badges'
import { common } from './strings/common'
import { contracts } from './strings/contracts'
import { nav } from './strings/nav'
import { people } from './strings/people'
import { project } from './strings/project'
import { projects } from './strings/projects'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  badges: badges.en,
  common: common.en,
  contracts: contracts.en,
  nav: nav.en,
  people: people.en,
  project: project.en,
  projects: projects.en,
}

/** The Italian catalog: typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  badges: badges.it,
  common: common.it,
  contracts: contracts.it,
  nav: nav.it,
  people: people.it,
  project: project.it,
  projects: projects.it,
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })

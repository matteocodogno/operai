/**
 * strings — every user-facing string of crm-ui, in English and Italian
 * (INC-24/25). One file per namespace under `./strings/`, aggregated here;
 * components import `strings` and never inline copy
 * (`lib/noHardcodedStrings.test.ts` scans all of `src/`).
 */
import { selectStrings } from '@operai/ui'
import { activities } from './strings/activities'
import { attachments } from './strings/attachments'
import { badges } from './strings/badges'
import { common } from './strings/common'
import { companies } from './strings/companies'
import { contacts } from './strings/contacts'
import { deals } from './strings/deals'
import { estimate } from './strings/estimate'
import { nav } from './strings/nav'
import { offerWizard } from './strings/offerWizard'
import { offers } from './strings/offers'
import { people } from './strings/people'
import { recordHours } from './strings/recordHours'
import { settings } from './strings/settings'
import { source } from './strings/source'
import { tasks } from './strings/tasks'
import { templates } from './strings/templates'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  activities: activities.en,
  attachments: attachments.en,
  badges: badges.en,
  common: common.en,
  companies: companies.en,
  contacts: contacts.en,
  deals: deals.en,
  estimate: estimate.en,
  nav: nav.en,
  offerWizard: offerWizard.en,
  offers: offers.en,
  people: people.en,
  recordHours: recordHours.en,
  settings: settings.en,
  source: source.en,
  tasks: tasks.en,
  templates: templates.en,
}

/** The Italian catalog (INC-25): typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  activities: activities.it,
  attachments: attachments.it,
  badges: badges.it,
  common: common.it,
  companies: companies.it,
  contacts: contacts.it,
  deals: deals.it,
  estimate: estimate.it,
  nav: nav.it,
  offerWizard: offerWizard.it,
  offers: offers.it,
  people: people.it,
  recordHours: recordHours.it,
  settings: settings.it,
  source: source.it,
  tasks: tasks.it,
  templates: templates.it,
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })

export type Strings = typeof en

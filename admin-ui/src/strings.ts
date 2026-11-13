/**
 * strings — every user-visible string of admin-ui (INC-24), in English and
 * Italian (INC-25). Components import `strings` and never inline copy;
 * `lib/noHardcodedStrings.test.ts` scans every `.tsx` under `src/` for that,
 * and `strings.test.ts` checks the Italian catalog is complete.
 *
 * One file per area under `./strings/`, each exporting its `en` catalog and an
 * `it` typed as it. The language is resolved once, by `@operai/ui`'s
 * `selectStrings` (`<html lang>` set by the shell, else the browser's
 * preferred languages, else English) — this app never detects it itself.
 */
import { selectStrings } from '@operai/ui'
import * as accessRequests from './strings/accessRequests'
import * as address from './strings/address'
import * as audit from './strings/audit'
import * as badges from './strings/badges'
import * as common from './strings/common'
import * as departments from './strings/departments'
import * as invitations from './strings/invitations'
import * as legalEntities from './strings/legalEntities'
import * as nav from './strings/nav'
import * as roles from './strings/roles'
import * as timeLists from './strings/timeLists'
import * as users from './strings/users'

export const en = {
  accessRequests: accessRequests.en,
  address: address.en,
  audit: audit.en,
  badges: badges.en,
  common: common.en,
  departments: departments.en,
  invitations: invitations.en,
  legalEntities: legalEntities.en,
  nav: nav.en,
  roles: roles.en,
  timeLists: timeLists.en,
  users: users.en,
}

export const it: typeof en = {
  accessRequests: accessRequests.it,
  address: address.it,
  audit: audit.it,
  badges: badges.it,
  common: common.it,
  departments: departments.it,
  invitations: invitations.it,
  legalEntities: legalEntities.it,
  nav: nav.it,
  roles: roles.it,
  timeLists: timeLists.it,
  users: users.it,
}

export type Strings = typeof en

export const strings: Strings = selectStrings({ en, it })

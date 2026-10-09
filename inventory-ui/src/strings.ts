/**
 * strings — every user-facing string of inventory-ui, English only at launch
 * (specs/015 design.md Resolutions G12/Q1). Components import `strings` and
 * never inline copy; `lib/noHardcodedStrings.test.ts` enforces that over all of
 * `src/`.
 *
 * One file per namespace under `./strings/`, aggregated here (T24) so later
 * tasks add keys to their own file and never edit this one. Mapping from
 * design.md § Strings and numbers: `pages.assets|register|assetDetail|rules|
 * years|yearDetail|myDevices` are `assets`, `register`, `assetDetail`,
 * `rules`, `years`, `yearDetail`, `myDevices`; `badges.assetStatus` lives in
 * `badges`; `dialogs.*` and `empty.*` have their own namespaces (a dialog owned
 * by one task may instead keep its copy in that task's own file);
 * `errors.<code>`, `history.<action>`, `categories`, `disposalReasons`, `nav`,
 * `actions` are as named. `common` holds shared labels and `invoice`/`ledger`
 * the asset detail regions; `notFound` the router fallback.
 */
import { actions } from './strings/actions'
import { assetDetail } from './strings/assetDetail'
import { assets } from './strings/assets'
import { badges } from './strings/badges'
import { categories } from './strings/categories'
import { common } from './strings/common'
import { dialogs } from './strings/dialogs'
import { disposalReasons } from './strings/disposalReasons'
import { empty } from './strings/empty'
import { errors } from './strings/errors'
import { history } from './strings/history'
import { invoice } from './strings/invoice'
import { ledger } from './strings/ledger'
import { myDevices } from './strings/myDevices'
import { nav } from './strings/nav'
import { notFound } from './strings/notFound'
import { register } from './strings/register'
import { rules } from './strings/rules'
import { years } from './strings/years'
import { yearDetail } from './strings/yearDetail'

export const strings = {
  actions,
  assetDetail,
  assets,
  badges,
  categories,
  common,
  dialogs,
  disposalReasons,
  empty,
  errors,
  history,
  invoice,
  ledger,
  myDevices,
  nav,
  notFound,
  register,
  rules,
  yearDetail,
  years,
} as const

export type Strings = typeof strings

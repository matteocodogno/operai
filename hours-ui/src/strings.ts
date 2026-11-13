/**
 * strings — every user-facing string of hours-ui, in English and Italian (AC-5.5). One file per
 * area under `./strings/`, aggregated here; components import `strings` and never inline copy
 * (`lib/noHardcodedStrings.test.ts` scans all of `src/`).
 *
 * The areas map to the tasks that fill them (tasks.md T22): `common` is the frame and the shared
 * states, `myHours`/`filters`/`totals`/`entries`/`names` belong to My hours (T24, T25), `activity`
 * and `entry` to the entry dialog (T26–T28), `everyone` to Everyone's hours (T29) and `export` to
 * the download (T30). Each task edits its own file and never this aggregator.
 */
import { selectStrings } from '@operai/ui'
import { activity } from './strings/activity'
import { common } from './strings/common'
import { entries } from './strings/entries'
import { entry } from './strings/entry'
import { everyone } from './strings/everyone'
import { exportStrings } from './strings/export'
import { filters } from './strings/filters'
import { myHours } from './strings/myHours'
import { names } from './strings/names'
import { totals } from './strings/totals'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  common: common.en,
  myHours: myHours.en,
  filters: filters.en,
  totals: totals.en,
  entries: entries.en,
  names: names.en,
  activity: activity.en,
  entry: entry.en,
  everyone: everyone.en,
  export: exportStrings.en,
}

/** The Italian catalog: typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  common: common.it,
  myHours: myHours.it,
  filters: filters.it,
  totals: totals.it,
  entries: entries.it,
  names: names.it,
  activity: activity.it,
  entry: entry.it,
  everyone: everyone.it,
  export: exportStrings.it,
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })

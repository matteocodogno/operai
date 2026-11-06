/**
 * strings — every user-facing string of meetings-ui, in English and Italian
 * (INC-24/25). One file per area under `./strings/`, aggregated here; components
 * import `strings` and never inline copy (`noHardcodedStrings.test.ts` scans all of `src/`).
 *
 * T53 creates every area module so that each later task fills its own file in place and
 * nobody edits this aggregator; `strings.test.ts` fails if a file under `strings/` is not
 * wired in here.
 */
import { selectStrings } from '@operai/ui'
import { ask } from './strings/ask'
import { audio } from './strings/audio'
import { capture } from './strings/capture'
import { common } from './strings/common'
import { consent } from './strings/consent'
import { editDetails } from './strings/editDetails'
import { erase } from './strings/erase'
import { host } from './strings/host'
import { list } from './strings/list'
import { meeting } from './strings/meeting'
import { nav } from './strings/nav'
import { newMeeting } from './strings/newMeeting'
import { participants } from './strings/participants'
import { summaries } from './strings/summaries'
import { templates } from './strings/templates'
import { text } from './strings/text'
import { transcript } from './strings/transcript'
import { upload } from './strings/upload'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  ask: ask.en,
  audio: audio.en,
  capture: capture.en,
  common: common.en,
  consent: consent.en,
  editDetails: editDetails.en,
  erase: erase.en,
  host: host.en,
  list: list.en,
  meeting: meeting.en,
  nav: nav.en,
  newMeeting: newMeeting.en,
  participants: participants.en,
  summaries: summaries.en,
  templates: templates.en,
  text: text.en,
  transcript: transcript.en,
  upload: upload.en,
}

/** The Italian catalog (INC-25): typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  ask: ask.it,
  audio: audio.it,
  capture: capture.it,
  common: common.it,
  consent: consent.it,
  editDetails: editDetails.it,
  erase: erase.it,
  host: host.it,
  list: list.it,
  meeting: meeting.it,
  nav: nav.it,
  newMeeting: newMeeting.it,
  participants: participants.it,
  summaries: summaries.it,
  templates: templates.it,
  text: text.it,
  transcript: transcript.it,
  upload: upload.it,
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })

export type Strings = typeof en

/**
 * meetingProject — the project a meeting entry counts for, read the one way everywhere (specs/20261112-project-hours T11; design G4;
 * plan § The hours views "Labels"). A meeting entry from an hours-api that predates this feature carries no `on.project`, and a
 * missing one reads as "linked to no project" (`{ state: 'none' }`), never as an unknown one: it says nothing on screen, in the
 * file or in the "names not visible" note. The screen's line, the "names not visible" rule and the export's cell all ask this, so
 * there is one answer to "what if it is absent".
 */
import type { EntryOn, MeetingProject } from './hoursApi.types'

export const meetingProjectOf = (on: Extract<EntryOn, { type: 'meeting' }>): MeetingProject =>
  on.project ?? { state: 'none' }

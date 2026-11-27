/**
 * What the project's team fields say about the teams section (specs/20261126-teams design S6 "Status rule", AC-5.4,
 * AC-5.6): ONE function of the project decides which banner shows, never one per block, and the wait the person is
 * told about. Pure; the words are `strings.project.team.teams`.
 */
import { ApiError } from './api'
import type { Project } from './types'
import { strings } from '../strings'

/** `rateLimited`: the person's own limit refused the read (AC-5.6); `unavailable`: anything else that was not read. */
export type TeamsBanner = 'none' | 'unavailable' | 'rateLimited'

/**
 * No attached team: nothing could be missing, whatever the status says. Otherwise `complete` with a complete
 * `onProject` is the only silence; `rate_limited` is its own banner (it is true, and the person can act on it by
 * waiting); everything else, a value this UI does not know or none at all included, reads as `unavailable`: the rule
 * fails toward saying that something could not be loaded, never toward saying nothing.
 */
export function teamsBannerOf(project: Pick<Project, 'teams' | 'teamsStatus' | 'onProjectComplete'>): TeamsBanner {
  if ((project.teams ?? []).length === 0) return 'none'
  if (project.teamsStatus === 'rate_limited' && project.onProjectComplete === false) return 'rateLimited'
  if (project.teamsStatus === 'complete' && project.onProjectComplete === true) return 'none'
  return 'unavailable'
}

/**
 * "Try again in 3 minutes.": whole seconds rounded UP to whole minutes ("a minute" for one). A number that is
 * not a whole number of at least 1 (missing, 0, a fraction, text) is "Try again later.": the contract rules it out,
 * the words never guess. The browser cannot read `Retry-After` (CORS), so the number comes from the body.
 */
export function waitSentence(seconds: unknown): string {
  const t = strings.project.team.teams.rateLimited
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) return t.retryLater
  return t.retryIn(Math.ceil(seconds / 60))
}

/** The `retryAfterSeconds` a 429 of projects-api carries in its body, or `null`. */
export const retryAfterSecondsOf = (error: unknown): number | null => {
  if (!(error instanceof ApiError)) return null
  const seconds = error.extras['retryAfterSeconds']
  return typeof seconds === 'number' ? seconds : null
}

/**
 * errors — what hours-api's refusals look like to a screen (specs/029-time-tracking, plan § API
 * contracts › Errors and § Lists).
 *
 * A non-2xx answer is RFC 7807 Problem JSON with a top-level `code`; `errorFromResponse` turns it
 * into an `HoursApiError` whose `code` is typed: one of the codes the plan lists, or `null` for a
 * code this build does not know (kept as `rawCode`, so a server one step ahead of the UI degrades
 * to the generic message instead of being mistaken for a known refusal). Screens branch on `code`,
 * never on the status alone: a 503 is `host_unavailable` (an owner did not answer a write, or the
 * meeting → deal link did not answer a deal filter, AC-4.11) or `authz_unavailable` (`auth` did not
 * answer an oversight read, AC-5.4), and the two read differently.
 *
 * A network failure is not an `HoursApiError`: `fetch`'s rejection propagates, and
 * `errorMessage` words it as the network line.
 */
import { strings } from '../strings'

/**
 * Every `code` hours-api answers (plan § Errors, § Lists). One list, so a task that words a refusal
 * never edits this file to learn it. The two list-management codes (`time_list_manage_required`,
 * `name_taken`) belong to admin-ui's screens and are known here so the mapping is complete.
 */
export const HOURS_ERROR_CODES = [
  // 400
  'invalid_request',
  // 422: the shape and the lists
  'invalid_minutes',
  'future_day',
  'note_too_long',
  'note_required',
  'category_not_found',
  'category_retired',
  'work_type_not_allowed',
  'work_type_not_found',
  'work_type_retired',
  'activity_not_allowed',
  // 403: the owners' bookability rules and the oversight permission
  'not_on_project',
  'not_involved_in_deal',
  'owner_only',
  'read_all_required',
  'time_list_manage_required',
  // 404 (identical for missing and unreadable, AC-2.10), 409, 503
  'not_found',
  'name_taken',
  'host_unavailable',
  'authz_unavailable',
] as const

export type HoursErrorCode = (typeof HOURS_ERROR_CODES)[number]

const isHoursErrorCode = (value: string | null): value is HoursErrorCode =>
  value !== null && (HOURS_ERROR_CODES as readonly string[]).includes(value)

/** Members of a Problem JSON body that `HoursApiError` models as named fields, not as extras. */
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'code'])

export class HoursApiError extends Error {
  readonly status: number
  readonly title: string
  /** The code, when it is one this build knows; `null` otherwise (see `rawCode`). */
  readonly code: HoursErrorCode | null
  /** The code as the server sent it, known or not; `null` when the answer carried none. */
  readonly rawCode: string | null
  readonly detail: string | undefined
  /** The Problem's other members (e.g. `field`), as sent. */
  readonly extras: Readonly<Record<string, unknown>>

  constructor(init: {
    status: number
    title: string
    rawCode?: string | null
    detail?: string
    extras?: Record<string, unknown>
  }) {
    super(init.title)
    this.name = 'HoursApiError'
    this.status = init.status
    this.title = init.title
    this.rawCode = init.rawCode ?? null
    this.code = isHoursErrorCode(this.rawCode) ? this.rawCode : null
    this.detail = init.detail
    this.extras = init.extras ?? {}
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Builds the error for a non-2xx response; a body that is not a Problem object falls back to the HTTP status. */
export const errorFromResponse = async (response: Response): Promise<HoursApiError> => {
  const fallbackTitle = response.statusText || String(response.status)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new HoursApiError({ status: response.status, title: fallbackTitle })
  }
  if (!isRecord(body)) return new HoursApiError({ status: response.status, title: fallbackTitle })

  return new HoursApiError({
    status: typeof body['status'] === 'number' ? body['status'] : response.status,
    title: asString(body['title']) ?? fallbackTitle,
    rawCode: asString(body['code']),
    detail: asString(body['detail']),
    extras: Object.fromEntries(Object.entries(body).filter(([key]) => !STANDARD_MEMBERS.has(key))),
  })
}

/** The HTTP status of a failed request, or `null` when it was not an answer from hours-api (a network failure). */
export const statusOf = (error: unknown): number | null => (error instanceof HoursApiError ? error.status : null)

/** The typed code of a failed request, or `null` (no code, a code this build does not know, or not an answer). */
export const codeOf = (error: unknown): HoursErrorCode | null => (error instanceof HoursApiError ? error.code : null)

/** Whether `error` is an answer from hours-api carrying one of `codes`. */
export const isCode = (error: unknown, ...codes: HoursErrorCode[]): boolean => {
  const code = codeOf(error)
  return code !== null && codes.includes(code)
}

/** The message for a failed request: the Problem `detail`, else a generic line; a network failure has its own. */
export const errorMessage = (error: unknown): string => {
  if (error instanceof HoursApiError) return error.detail ?? strings.common.unknownError
  return strings.common.networkError
}

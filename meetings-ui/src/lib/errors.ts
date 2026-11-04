/**
 * errors — turns a failed request into what the UI shows (design.md S11): the Problem `code`
 * picks a message from `strings.common.errors` (both languages), an unknown code falls back to
 * the server's `detail`, and `describeFailure` sorts a failed LOAD into the page-level state it
 * renders (building-pages § 2). One function, one place: pages never switch on status codes.
 */
import { ApiError } from './api'
import { strings } from '../strings'

export const statusOf = (error: unknown): number | null => (error instanceof ApiError ? error.status : null)

/** The Problem `code` of a failed request, or null. */
export const codeOf = (error: unknown): string | null => (error instanceof ApiError ? (error.code ?? null) : null)

type ErrorKey = keyof typeof strings.common.errors

/** An own key only: a code of `constructor` or `toString` must not resolve to an Object.prototype member. */
const isKnownCode = (code: string | null): code is ErrorKey =>
  code !== null && Object.prototype.hasOwnProperty.call(strings.common.errors, code)

/**
 * The message for a failed request: the catalog entry for its code (localised), else the Problem
 * `detail`, else a generic line; a non-ApiError is a network failure.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return strings.common.networkError
  const code = codeOf(error)
  if (isKnownCode(code)) return strings.common.errors[code]
  return error.detail ?? strings.common.unknownError
}

/** 503s that are NOT "auth is unreachable": each has its own message and the dialog stays open. */
const OTHER_503_CODES = new Set(['storage_unavailable', 'host_unavailable', 'identity_unavailable'])

/** A capability route answered 503 because `auth` cannot be reached (AC-10.6, ADR-0014). */
export const isAuthUnavailable = (error: unknown): boolean => {
  if (!(error instanceof ApiError) || error.status !== 503) return false
  return error.code === undefined || !OTHER_503_CODES.has(error.code)
}

/**
 * 403 codes that mean "you can open this, but not do that" (AC-5.8): the person stays on the page,
 * the message shows inline and the page refetches so its `can` flags catch up. Everything else
 * 403 is a page-level permission denial.
 */
const REFUSAL_CODES = new Set(['frozen', 'creator_only', 'meetings_access_required', 'author_only', 'builtin_readonly'])

export type FailureKind = 'forbidden' | 'notFound' | 'authUnavailable' | 'refused' | 'other'

export type Failure = { kind: FailureKind; message: string }

/** Sorts a failed load into the state the page renders. */
export function describeFailure(error: unknown): Failure {
  const message = errorMessage(error)
  const status = statusOf(error)
  if (status === 404) return { kind: 'notFound', message }
  if (status === 403) {
    const code = codeOf(error)
    return { kind: code !== null && REFUSAL_CODES.has(code) ? 'refused' : 'forbidden', message }
  }
  if (isAuthUnavailable(error)) return { kind: 'authUnavailable', message }
  return { kind: 'other', message }
}

export type FieldError = { field: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The field errors of a 422 (AC-1.3 names EVERY invalid field): an `errors[]` list of
 * `{field, message}` when the server sends one, else the single `field` with the Problem detail.
 * Malformed entries are skipped; a 422 that names no field (a host or participant error) is `[]`,
 * since those are handled by their `code`.
 */
export function fieldErrorsOf(error: unknown): FieldError[] {
  if (!(error instanceof ApiError) || error.status !== 422) return []
  const listed = error.extras['errors']
  if (Array.isArray(listed)) {
    const fields = listed.flatMap((entry): FieldError[] =>
      isRecord(entry) && typeof entry['field'] === 'string' && entry['field'] !== ''
        ? [
            {
              field: entry['field'],
              message: typeof entry['message'] === 'string' ? entry['message'] : strings.common.fixErrors,
            },
          ]
        : [],
    )
    if (fields.length > 0) return fields
  }
  const single = error.extras['field']
  return typeof single === 'string' && single !== ''
    ? [{ field: single, message: error.detail ?? strings.common.fixErrors }]
    : []
}

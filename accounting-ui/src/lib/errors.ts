import { ApiError } from './api'
import { strings } from '../strings'

/** The message to show for a failed request: the Problem `detail`, else a generic line (a network failure has none). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? strings.common.unknownError
  return strings.common.networkError
}

/** The HTTP status of a failed request, or null (a network failure has none). */
export const statusOf = (error: unknown): number | null => (error instanceof ApiError ? error.status : null)

/** The Problem `code` of a failed request, or null. */
export const codeOf = (error: unknown): string | null => (error instanceof ApiError ? (error.code ?? null) : null)

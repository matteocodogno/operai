/**
 * aiErrorMessage — what to say when a request that uses the AI fails (summaries, questions).
 *
 * A 429 names the time to retry from `Retry-After` (AC-13.4, AC-9.8); a 503 from `auth` says the
 * permission check is down (ADR-0014); everything else is the standard message for its code.
 */
import { formatDateTime } from '@operai/ui'
import { ApiError } from '../lib/api'
import { errorMessage, isAuthUnavailable } from '../lib/errors'
import { strings } from '../strings'

export function aiErrorMessage(error: unknown, rateLimited: (when: string) => string): string {
  if (isAuthUnavailable(error)) return strings.common.authUnavailable.body
  if (error instanceof ApiError && error.status === 429 && error.retryAfterSeconds !== null) {
    return rateLimited(formatDateTime(new Date(Date.now() + error.retryAfterSeconds * 1000)))
  }
  return errorMessage(error)
}

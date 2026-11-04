import { useCallback } from 'react'
import { PersonPicker as LibraryPersonPicker } from '@operai/ui'
import type { PersonChoice, PersonLoadFailure } from '@operai/ui'
import { ApiError } from '../lib/api'
import { listDirectory } from '../lib/crmApi'
import { strings } from '../strings'

export type { PersonChoice }

/** What a rejected directory call means to the picker: refused for this caller, throttled, or just failed. */
const classifyError = (error: unknown): PersonLoadFailure => {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: 'forbidden' }
    if (error.status === 429 && error.retryAfterSeconds !== null) {
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds }
    }
  }
  return { kind: 'failed' }
}

/**
 * PersonPicker — choose an Operai user (an owner, an assignee) from `auth`'s
 * directory (ADR-0047, widened to `deal:manage` holders by ADR-0053). The
 * behaviour is the library's `PersonPicker` (fetched once, filtered by name or
 * email in the browser); this adapter binds the CRM's directory call, its error
 * reading and its copy.
 *
 * A caller the directory refuses (403: they do not manage deals) cannot pick
 * someone else: the field shows the current choice read-only with a hint, and
 * the record keeps its default (the caller, for a new one — plan.md § UI).
 */
export default function PersonPicker({
  appId,
  label,
  value,
  onChange,
  error,
  required = false,
  exclude,
  clearOnSelect = false,
  testId,
}: {
  /** Only people who hold `(appId, "access")` are offered: `crm` for owners and assignees, `estimai` for a technician. */
  appId: 'crm' | 'estimai'
  label: string
  value: PersonChoice | null
  onChange: (value: PersonChoice | null) => void
  error?: string | null
  required?: boolean
  /** Ids not offered (people already chosen). */
  exclude?: readonly string[]
  /** Empties the field after a choice: the picker adds people to a list (specs/017 US-8). */
  clearOnSelect?: boolean
  testId: string
}) {
  const load = useCallback(
    (signal: AbortSignal) => listDirectory(appId, { signal }).then(({ users }) => users),
    [appId],
  )
  const t = strings.people.picker
  return (
    <LibraryPersonPicker
      label={label}
      load={load}
      loadKey={appId}
      classifyError={classifyError}
      value={value}
      onChange={onChange}
      error={error}
      required={required}
      exclude={exclude}
      clearOnSelect={clearOnSelect}
      testId={testId}
      copy={{
        loading: t.loading,
        noMatch: t.noMatch,
        failed: t.failed,
        noName: t.noName,
        results: t.results,
        rateLimited: t.rateLimited,
        unavailableHint: t.unavailableHint,
      }}
    />
  )
}

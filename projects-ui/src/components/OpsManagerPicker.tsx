import { Banner, Field } from '@operai/ui'
import type { ResourceState } from '../hooks/useResource'
import { errorMessage, takeRefusalOf } from '../lib/errors'
import type { OpsManagerList } from '../lib/types'
import { strings } from '../strings'

/**
 * OpsManagerPicker — choose the ops-manager a purchase order is assigned to (AC-4.1, AC-4.2, D44): the
 * holders of the role for the deal's entity, then the admins, each admin marked "All entities" (T18 L5).
 * The choice is required; the form prefills it with `prefillId` — the one role holder when there is
 * exactly one, admins not counted (D45) — and otherwise leaves it to the person.
 *
 * `candidates` is `GET /queue/{dealId}/ops-managers`, read by the form because the form needs its
 * `prefillId` to know the choice it submits. A list that cannot be read is said in its own words (auth
 * down: `identity_unavailable`), with Retry. `error` is the form's own refusal of the choice — none made,
 * or `ops_manager_invalid` — shown on the field.
 */
export default function OpsManagerPicker({
  candidates,
  value,
  onChange,
  error,
  testId,
}: {
  candidates: ResourceState<OpsManagerList>
  /** The chosen person's id; `''` when none is chosen. */
  value: string
  onChange: (id: string) => void
  error?: string | null
  testId: string
}) {
  const t = strings.queue.take.opsManager
  const items = candidates.data?.items ?? []
  const failure = candidates.status === 'error' ? candidates.error : null
  const refusal = failure === null ? null : takeRefusalOf(failure)

  return (
    <>
      <Field
        label={t.label}
        hint={candidates.status === 'ready' && items.length === 0 ? t.none : t.hint}
        required
        error={error}
        testId={testId}
      >
        {(control) => (
          <select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">{candidates.status === 'loading' ? t.loading : strings.common.choose}</option>
            {items.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name ?? strings.people.picker.noName}
                {candidate.admin ? ` — ${t.allEntities}` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failure !== null && (
        <Banner
          tone="warning"
          onRetry={candidates.retry}
          retryLabel={strings.common.retry}
          data-testid={`${testId}-error`}
        >
          {refusal ? strings.queue.take.errors[refusal] : errorMessage(failure)}
        </Banner>
      )}
    </>
  )
}

import { Banner, Field } from '@operai/ui'
import { useResource } from '../hooks/useResource'
import type { Fetcher } from '../hooks/useResource'
import { errorMessage, takeRefusalOf } from '../lib/errors'
import type { ContactChoice } from '../lib/types'
import { strings } from '../strings'

/**
 * ReferentPicker — choose the referent of a purchase order among the non-archived CRM contacts of its
 * company (AC-3.6, D41): "Jane Roe — CTO", after a "No referent" choice, so the referent may stay empty
 * and the form never depends on it. The company is the server's to derive (`load` is the deal's or the
 * project's own contacts route, never a company id the client names: T18 M1).
 *
 * The contacts are a third party's personal data (T18 M5): they are read every time the picker opens
 * (it loads on mount), live in this component's state only — no storage, no cache — and are rendered as
 * text. A CRM that cannot answer is said so in its own words, with Retry, and the form stays usable
 * without a referent. `error` is a refusal of the chosen contact (`referent_invalid`), shown on the field.
 *
 * `load` must be stable (`useCallback`): a new one is a new read. The take form's words are the default for
 * the hint and for a failed read; the purchase order's referent edit passes its own (`hint`, `failureText`,
 * the whole text of the warning), because "take deals" is not what a purchase order's refusal means.
 */
export default function ReferentPicker({
  load,
  value,
  onChange,
  error,
  hint,
  failureText,
  testId,
}: {
  load: Fetcher<{ items: ContactChoice[] }>
  /** The chosen contact's id; `null` when there is none. */
  value: string | null
  onChange: (contactId: string | null) => void
  error?: string | null
  /** Replaces the take form's hint ("Optional… You can set it later"). */
  hint?: string
  /** The whole warning for a contact list that could not be read; default: the take form's own words. */
  failureText?: (failure: unknown) => string
  testId: string
}) {
  const t = strings.queue.take.referent
  const contacts = useResource(load)
  const items = contacts.data?.items ?? []
  const loaded = contacts.status === 'ready'
  const failure = contacts.status === 'error' ? contacts.error : null
  const refusal = failure === null ? null : takeRefusalOf(failure)
  const failedText =
    failure === null
      ? ''
      : failureText
        ? failureText(failure)
        : `${t.loadFailed} ${refusal ? strings.queue.take.errors[refusal] : errorMessage(failure)}`

  return (
    <>
      <Field
        label={t.label}
        hint={loaded && items.length === 0 ? t.empty : (hint ?? t.hint)}
        error={error}
        testId={testId}
      >
        {(control) => (
          <select
            {...control}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
            data-testid={`${testId}-select`}
          >
            <option value="">{contacts.status === 'loading' ? t.loading : t.none}</option>
            {items.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {t.option(contact.name, contact.jobTitle)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failure !== null && (
        <Banner
          tone="warning"
          onRetry={contacts.retry}
          retryLabel={strings.common.retry}
          data-testid={`${testId}-error`}
        >
          {failedText}
        </Banner>
      )}
    </>
  )
}

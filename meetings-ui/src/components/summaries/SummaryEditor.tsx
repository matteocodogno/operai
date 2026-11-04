import { Button, Field } from '@operai/ui'
import { useEffect, useRef, useState } from 'react'
import { isStaleWrite } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { editSummary } from '../../lib/meetingsApi'
import type { Summary } from '../../lib/types'
import { strings } from '../../strings'
import { StaleWriteBanner } from '../LoadState'

/** The longest section body meetings-api accepts (plan § Summaries). */
export const SUMMARY_BODY_MAX = 8_000

export type SummaryEditorProps = {
  meetingId: string
  summary: Summary
  onSaved: (summary: Summary) => void
  onCancel: () => void
  /** The reload banner's action: the list loads again and the editor closes. */
  onReload: () => void
}

/** Inline editor of a ready summary: headings read-only, each body a textarea; `If-Match` is the summary's version (AC-7.7). */
export function SummaryEditor({ meetingId, summary, onSaved, onCancel, onReload }: SummaryEditorProps) {
  const sections = summary.sections ?? []
  const [bodies, setBodies] = useState(() => sections.map((section) => section.body))
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const first = useRef<HTMLTextAreaElement>(null)

  useEffect(() => first.current?.focus(), [])

  const save = async () => {
    if (busy) return
    if (bodies.some((body) => body.length > SUMMARY_BODY_MAX)) return setFieldError(strings.summaries.bodyTooLong)
    setFieldError(null)
    setFailure(null)
    setBusy(true)
    try {
      onSaved(
        await editSummary(
          meetingId,
          summary.id,
          summary.version,
          sections.map((section, index) => ({ heading: section.heading, body: bodies[index]! })),
        ),
      )
    } catch (error) {
      setBusy(false)
      if (isStaleWrite(error)) setStale(true)
      else setFailure(errorMessage(error))
    }
  }

  if (stale) return <StaleWriteBanner onReload={onReload} />

  return (
    <div className="flex flex-col gap-3" data-testid={`meetings-summary-editor-${summary.id}`}>
      <p className="text-xs text-soft">{strings.summaries.editHint}</p>
      {sections.map((section, index) => (
        <Field key={index} label={section.heading} error={index === 0 ? fieldError : null}>
          {(control) => (
            <textarea
              {...control}
              ref={index === 0 ? first : undefined}
              rows={4}
              value={bodies[index]}
              disabled={busy}
              onChange={(event) => setBodies(bodies.map((body, i) => (i === index ? event.target.value : body)))}
            />
          )}
        </Field>
      ))}
      {failure !== null && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {strings.common.cancel}
        </Button>
        <Button variant="primary" size="sm" busy={busy} onClick={() => void save()}>
          {busy ? strings.summaries.saving : strings.common.save}
        </Button>
      </div>
    </div>
  )
}

import { Button, Field } from '@operai/ui'
import { useEffect, useRef, useState } from 'react'
import { isStaleWrite } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { editSegment } from '../../lib/meetingsApi'
import type { TranscriptSegment } from '../../lib/types'
import { strings } from '../../strings'

/** The longest segment text meetings-api accepts (plan § Transcript). */
export const SEGMENT_TEXT_MAX = 10_000

export type SegmentEditorProps = {
  meetingId: string
  segment: TranscriptSegment
  onSaved: (segment: TranscriptSegment) => void
  onCancel: () => void
  /** The segment changed meanwhile (409 `version_conflict` / 428): the view shows the reload banner. */
  onStale: () => void
}

/** Inline editor of one segment's text (AC-6.3): `If-Match` is the segment's own version. */
export function SegmentEditor({ meetingId, segment, onSaved, onCancel, onStale }: SegmentEditorProps) {
  const [text, setText] = useState(segment.text)
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => box.current?.focus(), [])

  const save = async () => {
    if (busy) return
    if (text.trim() === '') return setFieldError(strings.transcript.textRequired)
    if (text.length > SEGMENT_TEXT_MAX) return setFieldError(strings.transcript.textTooLong)
    setFieldError(null)
    setFailure(null)
    setBusy(true)
    try {
      onSaved(await editSegment(meetingId, segment.id, segment.version, text))
    } catch (error) {
      setBusy(false)
      if (isStaleWrite(error)) onStale()
      else setFailure(errorMessage(error))
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`meetings-segment-editor-${segment.id}`}>
      <Field label={strings.transcript.segmentTextLabel} hint={strings.transcript.editHint} error={fieldError}>
        {(control) => (
          <textarea
            {...control}
            ref={box}
            rows={3}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
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
          {busy ? strings.transcript.saving : strings.common.save}
        </Button>
      </div>
    </div>
  )
}

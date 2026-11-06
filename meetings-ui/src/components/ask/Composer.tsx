import { Button, Field } from '@operai/ui'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { strings } from '../../strings'

/** The longest question meetings-api accepts (AC-9.1). */
export const QUESTION_MAX = 1000

export type ComposerProps = {
  busy: boolean
  /** A failure of the last send (rate limit, refusal, outage); the question stays in the box. */
  error: string | null
  /** Why asking is unavailable (no speech); the button waits, aria-disabled. */
  blockedReason: string | null
  /** Sends the question; resolves true when it was accepted, which clears the box. */
  onSend: (question: string) => Promise<boolean>
}

/** The question box (S3b): 1..1000 characters with a live count; Ctrl/Cmd+Enter sends, Enter adds a line. */
export function Composer({ busy, error, blockedReason, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)

  const submit = async () => {
    if (busy || blockedReason !== null) return
    const question = text.trim()
    if (question === '') return setInvalid(strings.ask.composer.required)
    if (question.length > QUESTION_MAX) return setInvalid(strings.ask.composer.tooLong)
    setInvalid(null)
    if (await onSend(question)) setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
    }
  }

  const reasonId = 'meetings-ask-reason'
  return (
    <div className="flex flex-col gap-2" data-testid="meetings-ask-composer">
      <Field
        label={strings.ask.composer.label}
        hint={
          <>
            {strings.ask.composer.hint} <span className="font-mono">{strings.ask.composer.counter(text.length)}</span>
          </>
        }
        error={invalid}
      >
        {(control) => (
          <textarea
            {...control}
            rows={3}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </Field>
      {error !== null && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {blockedReason !== null && (
        <p id={reasonId} className="text-xs text-soft">
          {blockedReason}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          busy={busy}
          aria-disabled={blockedReason !== null || undefined}
          aria-describedby={blockedReason !== null ? reasonId : undefined}
          onClick={() => void submit()}
        >
          {busy ? strings.ask.composer.asking : strings.ask.composer.ask}
        </Button>
      </div>
    </div>
  )
}

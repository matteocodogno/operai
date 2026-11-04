import { Banner, Button, ConfirmDialog, StatePanel } from '@operai/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useResource } from '../../hooks/useResource'
import { errorMessage } from '../../lib/errors'
import { askQuestion, clearConversation, getConversation, retryQuestion } from '../../lib/meetingsApi'
import type { ConversationTurn, Meeting } from '../../lib/types'
import { strings } from '../../strings'
import { aiErrorMessage } from '../aiError'
import { LoadFailure, Loading } from '../LoadState'
import { Composer } from './Composer'
import { takeRememberedSource } from './returnFocus'
import { Turn } from './Turn'

export type AskPanelProps = {
  meeting: Meeting
  /** A source was activated: the page switches to the Transcript tab and focuses that segment (F12). */
  onOpenSource: (segmentId: string) => void
}

type Conversation = { turns: ConversationTurn[] }

/** The Ask tab (S3b): the caller's own conversation with this meeting, and the composer. */
export default function AskPanel(props: AskPanelProps) {
  const fetcher = useCallback(
    (signal: AbortSignal) => getConversation(props.meeting.id, { signal }),
    [props.meeting.id],
  )
  const resource = useResource<Conversation>(fetcher)
  if (resource.status === 'loading') return <Loading label={strings.ask.loading} />
  if (resource.status === 'error' || resource.data === null) {
    return <LoadFailure error={resource.error} onRetry={resource.retry} />
  }
  return <Conversation {...props} turns={resource.data.turns} onTurns={(turns) => resource.replace({ turns })} />
}

function Conversation({
  meeting,
  onOpenSource,
  turns,
  onTurns,
}: AskPanelProps & { turns: ConversationTurn[]; onTurns: (turns: ConversationTurn[]) => void }) {
  const [asking, setAsking] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)

  // Coming back from a cited segment: focus the source that was opened (F12).
  useEffect(() => {
    const key = takeRememberedSource(meeting.id)
    if (key === null) return
    const buttons = root.current?.querySelectorAll<HTMLElement>('[data-source]') ?? []
    Array.from(buttons)
      .find((button) => button.dataset['source'] === key)
      ?.focus()
  }, [meeting.id])

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' })
  }, [turns.length, asking])

  const canAsk = meeting.can.ask
  const blockedReason = meeting.noSpeech ? strings.ask.composer.noSpeech : null

  const send = async (question: string): Promise<boolean> => {
    setSendError(null)
    setAsking(question)
    try {
      onTurns([...turns, await askQuestion(meeting.id, question)])
      return true
    } catch (error) {
      setSendError(aiErrorMessage(error, strings.ask.rateLimited))
      return false
    } finally {
      setAsking(null)
    }
  }

  const retry = async (turn: ConversationTurn) => {
    setRetryError(null)
    setRetrying(turn.id)
    try {
      const next = await retryQuestion(meeting.id, turn.id)
      onTurns(turns.map((existing) => (existing.id === turn.id ? next : existing)))
    } catch (error) {
      setRetryError(aiErrorMessage(error, strings.ask.rateLimited))
    } finally {
      setRetrying(null)
    }
  }

  const clear = async () => {
    setClearError(null)
    setClearBusy(true)
    try {
      await clearConversation(meeting.id)
      onTurns([])
      setClearing(false)
    } catch (error) {
      setClearError(errorMessage(error))
    } finally {
      setClearBusy(false)
    }
  }

  const inFlight: ConversationTurn | null =
    asking === null ? null : { id: 'in-flight', question: asking, status: 'pending', answer: null, createdAt: '' }
  const shown = inFlight === null ? turns : [...turns, inFlight]

  return (
    <div ref={root} className="flex flex-col gap-4" data-testid="meetings-ask">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-soft">{strings.ask.privacy}</p>
        {turns.length > 0 && (
          <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => setClearing(true)}>
            {strings.ask.clear.button}
          </Button>
        )}
      </div>
      {retryError !== null && (
        <Banner tone="danger" onDismiss={() => setRetryError(null)} dismissLabel={strings.common.dismiss}>
          {retryError}
        </Banner>
      )}
      {shown.length === 0 ? (
        <StatePanel title={strings.ask.empty.heading}>{strings.ask.empty.body}</StatePanel>
      ) : (
        <ol
          aria-label={strings.ask.conversationLabel}
          tabIndex={0}
          className="max-h-[32rem] divide-y divide-rule overflow-y-auto"
        >
          {shown.map((turn) => (
            <Turn
              key={turn.id}
              meetingId={meeting.id}
              turn={turn}
              onOpenSource={onOpenSource}
              onRetry={canAsk && retrying === null ? () => void retry(turn) : null}
            />
          ))}
        </ol>
      )}
      <div ref={end} />
      {canAsk && <Composer busy={asking !== null} error={sendError} blockedReason={blockedReason} onSend={send} />}
      {clearing && (
        <ConfirmDialog
          title={strings.ask.clear.title}
          confirmLabel={strings.ask.clear.confirm}
          busyLabel={strings.ask.clear.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={clearBusy}
          error={clearError}
          onConfirm={() => void clear()}
          onCancel={() => setClearing(false)}
          testIdPrefix="meetings-clear-conversation"
        >
          {strings.ask.clear.body}
        </ConfirmDialog>
      )}
    </div>
  )
}

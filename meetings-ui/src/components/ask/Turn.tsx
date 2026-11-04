import { Badge, Banner, Icon, Spinner } from '@operai/ui'
import type { ConversationTurn } from '../../lib/types'
import { strings } from '../../strings'
import { Sources } from './Sources'

export type TurnProps = {
  meetingId: string
  turn: ConversationTurn
  onOpenSource: (segmentId: string) => void
  /** Offered on a failed turn (AC-9.6); null while a retry is running or the caller cannot ask. */
  onRetry: (() => void) | null
}

/**
 * One question and its answer. The question and the AI's answer are plain text — React text nodes in
 * a `whitespace-pre-line` paragraph, never HTML or Markdown (ADR-0067).
 */
export function Turn({ meetingId, turn, onOpenSource, onRetry }: TurnProps) {
  const answer = turn.status === 'answered' ? turn.answer : null
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`meetings-turn-${turn.id}`}>
      <div>
        <p className="text-xs text-soft">{strings.ask.you}</p>
        <p className="whitespace-pre-line break-words text-sm text-text">{turn.question}</p>
      </div>
      {turn.status === 'pending' && (
        <p className="flex items-center gap-2 text-sm text-soft" role="status">
          <Spinner /> {strings.ask.thinking}
        </p>
      )}
      {turn.status === 'failed' && (
        <Banner tone="danger" compact onRetry={onRetry ?? undefined} retryLabel={strings.ask.tryAgain}>
          {strings.ask.failed}
        </Banner>
      )}
      {answer !== null && (
        <div className="flex flex-col gap-2">
          <Badge tone="accent" glyph={<Icon name="sparkle" />} className="self-start">
            {strings.ask.aiGenerated}
          </Badge>
          <p className="whitespace-pre-line break-words text-sm text-text">{answer.text}</p>
          {!answer.notInMeeting && (
            <Sources meetingId={meetingId} turnId={turn.id} citations={answer.citations} onOpen={onOpenSource} />
          )}
        </div>
      )}
    </li>
  )
}

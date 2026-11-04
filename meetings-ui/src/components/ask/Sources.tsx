import { Button } from '@operai/ui'
import type { Citation } from '../../lib/types'
import { strings } from '../../strings'
import { clockOf } from '../transcript/exportText'
import { rememberSource } from './returnFocus'

export type SourcesProps = {
  meetingId: string
  turnId: string
  citations: Citation[]
  /** A source was activated: open that segment in the transcript. */
  onOpen: (segmentId: string) => void
}

/** The passages that support an answer (AC-9.3): "00:12:34 · Speaker 2", or "Passage 3" for a text meeting. */
export function Sources({ meetingId, turnId, citations, onOpen }: SourcesProps) {
  if (citations.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-soft">{strings.ask.sources}</p>
      <ul className="flex flex-wrap gap-2">
        {citations.map((citation) => (
          <li key={citation.segmentId}>
            <Button
              variant="secondary"
              size="sm"
              data-source={`${turnId}:${citation.segmentId}`}
              onClick={() => {
                rememberSource(meetingId, `${turnId}:${citation.segmentId}`)
                onOpen(citation.segmentId)
              }}
            >
              {citation.startMs === null
                ? strings.ask.sourcePassage(citation.ordinal)
                : strings.ask.source(clockOf(citation.startMs), citation.speaker)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

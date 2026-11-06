import { Badge, Button, Icon, VisuallyHidden, cx, formatDuration } from '@operai/ui'
import type { ReactNode, Ref } from 'react'
import type { TranscriptSegment } from '../../lib/types'
import { strings } from '../../strings'
import { clockOf } from './exportText'
import type { Range } from './fold'
import { Highlight } from './Highlight'

export type SegmentRowProps = {
  segment: TranscriptSegment
  /** The speaker's display name; null for a text meeting's passage. */
  speaker: string | null
  /** Search hits in `segment.text`. */
  ranges: Range[]
  /** Set while the audio is kept: the time becomes a button that plays from here (AC-6.5). */
  onPlay: (() => void) | null
  /** The segment an answer cited (F12). */
  cited: boolean
  rowRef: Ref<HTMLLIElement>
  /** Set for the creator (`can.editTranscript`): opens the inline editor. */
  onEdit: (() => void) | null
  editLabel: string
  /** The inline editor, while this segment is being edited: it takes the place of the text. */
  editor: ReactNode
}

/** One transcript line: time, speaker, text, the "Edited" mark. Text is rendered as plain text only. */
export function SegmentRow({ segment, speaker, ranges, onPlay, cited, rowRef, onEdit, editLabel, editor }: SegmentRowProps) {
  const timed = segment.startMs !== null
  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      aria-current={cited ? 'true' : undefined}
      data-testid={`meetings-segment-${segment.id}`}
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-1 border-l-2 py-2 pl-3',
        cited ? 'border-l-acc bg-acc/10' : 'border-l-rule/0',
      )}
    >
      {timed &&
        (onPlay === null ? (
          <span className="font-mono text-xs text-soft">{clockOf(segment.startMs!)}</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="font-mono"
            aria-label={strings.transcript.playFrom(formatDuration(segment.startMs!, { style: 'spoken' }))}
            onClick={onPlay}
          >
            {clockOf(segment.startMs!)}
          </Button>
        ))}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-xs text-soft">
          {speaker !== null && <span className="font-medium text-text">{speaker}</span>}
          {segment.edited && <Badge>{strings.transcript.edited}</Badge>}
        </p>
        {editor ?? (
          <p className="whitespace-pre-line break-words text-sm text-text">
            {cited && <VisuallyHidden>{strings.transcript.citedPassage} </VisuallyHidden>}
            <Highlight text={segment.text} ranges={ranges} />
          </p>
        )}
      </div>
      {onEdit !== null && editor === null && (
        <Button variant="ghost" size="sm" iconOnly aria-label={editLabel} data-edit onClick={onEdit}>
          <Icon name="edit" />
        </Button>
      )}
    </li>
  )
}

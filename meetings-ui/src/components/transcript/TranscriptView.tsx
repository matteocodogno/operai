import { Banner, Button, Field, Icon, StatePanel, VisuallyHidden } from '@operai/ui'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoadFailure, Loading, StaleWriteBanner } from '../LoadState'
import { useResource } from '../../hooks/useResource'
import { getTranscript } from '../../lib/meetingsApi'
import { passageNumber } from '../../lib/passageNumber'
import type { Meeting, Transcript, TranscriptPart } from '../../lib/types'
import { strings } from '../../strings'
import { AudioControl } from './AudioControl'
import type { AudioHandle } from './AudioControl'
import { clockOf, exportText, inOrder, partStartingAt, speakerNameOf, textFileName } from './exportText'
import { findMatches } from './fold'
import { SegmentEditor } from './SegmentEditor'
import { SegmentRow } from './SegmentRow'
import { SpeakerRenameDialog } from './SpeakerRenameDialog'

export type TranscriptViewProps = {
  meeting: Meeting
  /** The cited segment to highlight and focus (from the Ask tab), or null. */
  focusSegmentId: string | null
  /** Returns focus to the citation that opened this segment; null when nothing opened it (F12). */
  onBackToAnswer: (() => void) | null
}

/** The Transcript tab (S3b): segments with time and speaker, search, copy and download as text. */
export default function TranscriptView(props: TranscriptViewProps) {
  if (props.meeting.noSpeech) {
    return (
      <StatePanel title={strings.transcript.noSpeech.heading} testId="meetings-transcript-no-speech">
        {strings.transcript.noSpeech.body}
      </StatePanel>
    )
  }
  return <LoadedTranscript {...props} />
}

function LoadedTranscript({ meeting, focusSegmentId, onBackToAnswer }: TranscriptViewProps) {
  const fetcher = useCallback(
    (signal: AbortSignal) => getTranscript(meeting.id, { signal }),
    // A new transcript version (an edit seen by the page) is a new load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meeting.id, meeting.transcriptVersion],
  )
  const resource = useResource<Transcript>(fetcher)

  if (resource.status === 'loading') return <Loading label={strings.transcript.loading} />
  if (resource.status === 'error' || resource.data === null) {
    return <LoadFailure error={resource.error} onRetry={resource.retry} />
  }
  return (
    <TranscriptBody
      meeting={meeting}
      transcript={resource.data}
      onTranscript={resource.replace}
      onReload={resource.retry}
      focusSegmentId={focusSegmentId}
      onBackToAnswer={onBackToAnswer}
    />
  )
}

type BodyProps = {
  meeting: Meeting
  transcript: Transcript
  /** A correction changed the transcript: show this one. */
  onTranscript: (transcript: Transcript) => void
  onReload: () => void
  focusSegmentId: string | null
  onBackToAnswer: (() => void) | null
}

function TranscriptBody({ meeting, transcript, onTranscript, onReload, focusSegmentId, onBackToAnswer }: BodyProps) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<'copied' | 'copyFailed' | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const audio = useRef<AudioHandle>(null)
  const audioKept = meeting.audio.state === 'kept'
  const [editing, setEditing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const canEdit = meeting.can.editTranscript
  // After an editor closes, focus goes back to that segment's Edit button (or its row).
  const lastEdited = useRef<string | null>(null)
  useEffect(() => {
    if (editing !== null) {
      lastEdited.current = editing
      return
    }
    const id = lastEdited.current
    lastEdited.current = null
    const row = id === null ? undefined : rows.current.get(id)
    if (row !== undefined) (row.querySelector<HTMLElement>('[data-edit]') ?? row).focus()
  }, [editing])

  const segments = useMemo(() => inOrder(transcript.segments), [transcript.segments])
  // Counts and highlights come from the data, never from the DOM.
  const hits = useMemo(() => segments.map((segment) => findMatches(segment.text, query)), [segments, query])
  const total = hits.reduce((sum, ranges) => sum + ranges.length, 0)
  const searching = query.trim() !== ''

  useEffect(() => {
    if (focusSegmentId === null) return
    const row = rows.current.get(focusSegmentId)
    if (row === undefined) return
    row.scrollIntoView?.({ block: 'center' })
    row.focus({ preventScroll: true })
  }, [focusSegmentId, segments])

  const text = () => exportText(segments, transcript.speakers, meeting.participants)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text())
      setNotice('copied')
    } catch {
      setNotice('copyFailed')
    }
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = textFileName(meeting.title, strings.transcript.downloadFileName)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  if (segments.length === 0) {
    return <StatePanel title={strings.transcript.empty.heading}>{strings.transcript.empty.body}</StatePanel>
  }

  const isText = meeting.source === 'text'
  // A long recording transcribed in parts (AC-6.2): say so once, and open each later part with a divider.
  // `parts` is absent on a backend that predates it, which reads as a single part.
  const partCount = (transcript.parts as TranscriptPart[] | undefined)?.length ?? 0
  const manyParts = partCount > 1
  return (
    <div className="flex flex-col gap-4" data-testid="meetings-transcript">
      <AudioControl meeting={meeting} ref={audio} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={strings.transcript.searchLabel} className="min-w-48 flex-1">
          {(control) => (
            <input
              {...control}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          <Icon name="copy" /> {strings.transcript.copy}
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          <Icon name="download" /> {strings.transcript.download}
        </Button>
      </div>
      {searching && (
        <p role="status" className="text-xs text-soft">
          {strings.transcript.matches(total)}
        </p>
      )}
      <VisuallyHidden live>
        {notice === 'copied' ? strings.transcript.copied : notice === 'copyFailed' ? strings.transcript.copyFailed : ''}
      </VisuallyHidden>
      {notice === 'copyFailed' && <p className="text-xs text-red-text">{strings.transcript.copyFailed}</p>}
      {manyParts && (
        <Banner tone="info" data-testid="meetings-transcript-parts-banner">
          {strings.transcript.parts.banner(partCount)}
        </Banner>
      )}
      {stale && <StaleWriteBanner onReload={onReload} />}
      {canEdit && transcript.speakers.length > 0 && (
        <ul aria-label={strings.transcript.speakersHeading} className="flex flex-wrap gap-2">
          {transcript.speakers.map((speaker) => {
            const name = speakerNameOf(speaker.key, transcript.speakers, meeting.participants) ?? ''
            return (
              <li key={speaker.key} className="flex items-center gap-1 text-sm">
                <span>{name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={strings.transcript.rename(name)}
                  onClick={() => setRenaming(speaker.key)}
                >
                  <Icon name="pencil" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {focusSegmentId !== null && onBackToAnswer !== null && (
        <div>
          <Button variant="ghost" size="sm" onClick={onBackToAnswer}>
            <Icon name="arrow-left" /> {strings.transcript.backToAnswer}
          </Button>
        </div>
      )}
      <ol
        aria-label={isText ? strings.transcript.passagesHeading : strings.transcript.heading}
        className="flex flex-col"
      >
        {segments.map((segment, index) => {
          const opened = manyParts ? partStartingAt(segments, index, transcript.parts) : null
          return (
          <Fragment key={segment.id}>
            {opened !== null && (
              <li
                role="separator"
                aria-label={strings.transcript.parts.divider(opened.index, clockOf(opened.startMs))}
                className="mt-3 border-t border-rule pt-2 font-mono text-xs text-soft"
              >
                {strings.transcript.parts.divider(opened.index, clockOf(opened.startMs))}
              </li>
            )}
          <SegmentRow
            segment={segment}
            speaker={speakerNameOf(segment.speakerKey, transcript.speakers, meeting.participants)}
            ranges={hits[index]!}
            onPlay={audioKept && segment.startMs !== null ? () => audio.current?.playFrom(segment.startMs!) : null}
            onEdit={canEdit ? () => setEditing(segment.id) : null}
            editLabel={
              segment.startMs === null
                ? strings.transcript.editPassage(passageNumber(segment.ordinal))
                : strings.transcript.editSegment(clockOf(segment.startMs))
            }
            editor={
              editing === segment.id ? (
                <SegmentEditor
                  meetingId={meeting.id}
                  segment={segment}
                  onCancel={() => setEditing(null)}
                  onStale={() => {
                    setEditing(null)
                    setStale(true)
                  }}
                  onSaved={(saved) => {
                    onTranscript({
                      ...transcript,
                      segments: transcript.segments.map((s) => (s.id === saved.id ? saved : s)),
                    })
                    setEditing(null)
                  }}
                />
              ) : null
            }
            cited={segment.id === focusSegmentId}
            rowRef={(element) => {
              if (element === null) rows.current.delete(segment.id)
              else rows.current.set(segment.id, element)
            }}
          />
          </Fragment>
          )
        })}
      </ol>
      {renaming !== null && (
        <SpeakerRenameDialog
          meetingId={meeting.id}
          speaker={transcript.speakers.find((speaker) => speaker.key === renaming)!}
          currentName={speakerNameOf(renaming, transcript.speakers, meeting.participants) ?? ''}
          participants={meeting.participants}
          onClose={() => setRenaming(null)}
          onSaved={(saved) => {
            onTranscript({
              ...transcript,
              speakers: transcript.speakers.map((speaker) => (speaker.key === saved.key ? saved : speaker)),
            })
            setRenaming(null)
          }}
        />
      )}
    </div>
  )
}

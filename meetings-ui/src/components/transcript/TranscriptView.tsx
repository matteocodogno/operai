import { Banner, Button, Field, Icon, StatePanel, VisuallyHidden, formatDuration } from '@operai/ui'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoadFailure, Loading, StaleWriteBanner } from '../LoadState'
import { useResource } from '../../hooks/useResource'
import { getTranscript } from '../../lib/meetingsApi'
import { passageNumber } from '../../lib/passageNumber'
import type { Meeting, TimeRange, Transcript, TranscriptPart } from '../../lib/types'
import { strings } from '../../strings'
import { AudioControl } from './AudioControl'
import type { AudioHandle } from './AudioControl'
import {
  clockOf,
  exportText,
  gapMarkerText,
  gapsBefore,
  inOrder,
  noticeRanges,
  partsText,
  speakerNameOf,
  textFileName,
} from './exportText'
import { findMatches } from './fold'
import { SegmentEditor } from './SegmentEditor'
import { SegmentRow } from './SegmentRow'
import { SeparateSpeakerDialog } from './SeparateSpeakerDialog'
import { SpeakerRenameDialog } from './SpeakerRenameDialog'

export type TranscriptViewProps = {
  meeting: Meeting
  /** The cited segment to highlight and focus (from the Ask tab), or null. */
  focusSegmentId: string | null
  /** Returns focus to the citation that opened this segment; null when nothing opened it (F12). */
  onBackToAnswer: (() => void) | null
  /** An answer's "may be incomplete" label was followed: scroll to the notice and focus it (AC-9.9). */
  focusNotice?: boolean
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

function LoadedTranscript({ meeting, focusSegmentId, onBackToAnswer, focusNotice = false }: TranscriptViewProps) {
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
      focusNotice={focusNotice}
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
  focusNotice: boolean
}

/** What one block of the transcript is: a list of rows, a part divider, or a gap marker. */
type Block =
  | { kind: 'divider'; part: TranscriptPart; text: string }
  | { kind: 'gap'; gap: TimeRange }
  | { kind: 'rows'; label: string; indexes: number[] }

function TranscriptBody({
  meeting,
  transcript,
  onTranscript,
  onReload,
  focusSegmentId,
  onBackToAnswer,
  focusNotice,
}: BodyProps) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<'copied' | 'copyFailed' | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const audio = useRef<AudioHandle>(null)
  const incompleteNotice = useRef<HTMLDivElement>(null)
  const speakersList = useRef<HTMLUListElement>(null)
  const audioKept = meeting.audio.state === 'kept'
  const [editing, setEditing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [separating, setSeparating] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const canEdit = meeting.can.editTranscript
  const gaps = transcript.gaps
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

  // An answer's label led here (AC-9.9): show the notice it points to.
  useEffect(() => {
    if (!focusNotice) return
    const element = incompleteNotice.current
    if (element === null) return
    element.scrollIntoView?.({ block: 'start' })
    element.focus({ preventScroll: true })
  }, [focusNotice, gaps.length])

  const text = () => exportText(segments, transcript.speakers, meeting.participants, gaps)

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

  // The label was separated: take the server's labels, then read the transcript again, since the
  // segments of the later parts now carry other keys. A failed read leaves the labels and offers Reload.
  const afterSeparate = async (speakers: Transcript['speakers']) => {
    setSeparating(null)
    try {
      onTranscript(await getTranscript(meeting.id))
    } catch {
      onTranscript({ ...transcript, speakers })
      setStale(true)
    }
    speakersList.current?.focus()
  }

  if (segments.length === 0) {
    return <StatePanel title={strings.transcript.empty.heading}>{strings.transcript.empty.body}</StatePanel>
  }

  const isText = meeting.source === 'text'
  const playFrom = (ms: number) => () => audio.current?.playFrom(ms)
  const playLabel = (ms: number) => strings.transcript.playFrom(formatDuration(ms, { style: 'spoken' }))

  // A long recording transcribed in parts (AC-6.2): a divider opens each part after the first, by the
  // segment's own `part` — with overlapping parts, time cannot say which part a segment belongs to.
  const partCount = transcript.parts.length
  const manyParts = partCount > 1
  const partByIndex = new Map(transcript.parts.map((part) => [part.index, part]))
  // AC-6.15: only a label that stayed separate says "one person can appear under two labels".
  const showPartsBanner = manyParts && transcript.separateLabels

  // The transcript as blocks, in order: rows between dividers (parts) and markers (gaps). Neither is a
  // list item, so each sits between lists (WCAG 1.3.1).
  const markers = gapsBefore(segments, gaps)
  const blocks: Block[] = []
  const seenParts = new Set<number>()
  let label = isText ? strings.transcript.passagesHeading : strings.transcript.heading
  let open: Extract<Block, { kind: 'rows' }> | null = null
  for (const [index, segment] of segments.entries()) {
    for (const gap of markers.get(index) ?? []) {
      blocks.push({ kind: 'gap', gap })
      open = null
    }
    const part = segment.part
    const opened = manyParts && part !== null && part > 1 && !seenParts.has(part) ? partByIndex.get(part) : undefined
    if (part !== null) seenParts.add(part)
    if (opened !== undefined) {
      const dividerText = strings.transcript.parts.divider(opened.index, clockOf(opened.startMs))
      blocks.push({ kind: 'divider', part: opened, text: dividerText })
      label = dividerText
      open = null
    }
    if (open === null) {
      open = { kind: 'rows', label, indexes: [] }
      blocks.push(open)
    }
    open.indexes.push(index)
  }
  for (const gap of markers.get(segments.length) ?? []) blocks.push({ kind: 'gap', gap })

  const listSpeakers = transcript.speakers.length > 0 && (canEdit || transcript.speakers.some((s) => s.joined))
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
      {gaps.length > 0 && (
        // Possibly incomplete (AC-6.12): everyone who can open the meeting sees it, it cannot be
        // dismissed, and editing the transcript does not remove it. The id is the anchor of the
        // "may be incomplete" label on summaries and answers. A persistent condition, not time-critical:
        // `live="off"` keeps the warning look without an assertive alert (design.md accessibility).
        <Banner
          tone="warning"
          live="off"
          aria-label={strings.transcript.incomplete.label}
          id="meetings-transcript-incomplete"
          tabIndex={-1}
          ref={incompleteNotice}
          data-testid="meetings-transcript-incomplete"
        >
          <p>{strings.transcript.incomplete.notice(noticeRanges(gaps))}</p>
          {audioKept && (
            <ul aria-label={strings.transcript.incomplete.rangesLabel} className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {gaps.map((gap) => (
                <li key={gap.startMs} className="flex items-center gap-1">
                  <span className="font-mono text-xs">
                    {clockOf(gap.startMs)}–{clockOf(gap.endMs)}
                  </span>
                  <Button variant="ghost" size="sm" aria-label={playLabel(gap.startMs)} onClick={playFrom(gap.startMs)}>
                    <Icon name="play" /> {strings.transcript.incomplete.play}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {showPartsBanner && (
        <Banner tone="info" data-testid="meetings-transcript-parts-banner">
          {strings.transcript.parts.banner(partCount)}
        </Banner>
      )}
      {stale && <StaleWriteBanner onReload={onReload} />}
      {listSpeakers && (
        <ul
          ref={speakersList}
          tabIndex={-1}
          aria-label={strings.transcript.speakersHeading}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {transcript.speakers.map((speaker) => {
            const name = speakerNameOf(speaker.key, transcript.speakers, meeting.participants) ?? ''
            const onlyPart = manyParts && !speaker.joined && speaker.parts.length === 1 ? speaker.parts[0] : undefined
            return (
              <li key={speaker.key} className="flex flex-wrap items-center gap-1 text-sm">
                <span>{name}</span>
                {onlyPart !== undefined && (
                  <span className="text-xs text-soft">({strings.transcript.joined.part(onlyPart)})</span>
                )}
                {speaker.joined && (
                  <span className="flex items-center gap-1 text-xs text-soft">
                    <Icon name="users" /> {strings.transcript.joined.note(partsText(speaker.parts))}
                  </span>
                )}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-haspopup="dialog"
                    aria-label={strings.transcript.rename(name)}
                    onClick={() => setRenaming(speaker.key)}
                  >
                    <Icon name="pencil" />
                  </Button>
                )}
                {canEdit && speaker.joined && (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-haspopup="dialog"
                    aria-label={strings.transcript.joined.separateLabel(name)}
                    onClick={() => setSeparating(speaker.key)}
                  >
                    {strings.transcript.joined.separate}
                  </Button>
                )}
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
      {blocks.map((block) => {
        if (block.kind === 'divider') {
          return (
            <div
              key={`part-${block.part.index}`}
              role="separator"
              aria-label={block.text}
              className="mt-3 border-t border-rule pt-2 font-mono text-xs text-soft"
            >
              {block.text}
            </div>
          )
        }
        if (block.kind === 'gap') {
          return (
            <div
              key={`gap-${block.gap.startMs}`}
              data-testid="meetings-transcript-gap"
              className="mt-3 flex flex-wrap items-center gap-2 border-t border-dashed border-rule pt-2 font-mono text-xs text-soft"
            >
              <Icon name="alert" />
              <span>{gapMarkerText(block.gap)}</span>
              {audioKept && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={playLabel(block.gap.startMs)}
                  onClick={playFrom(block.gap.startMs)}
                >
                  <Icon name="play" /> {strings.transcript.incomplete.play}
                </Button>
              )}
            </div>
          )
        }
        return (
          <Fragment key={`rows-${block.indexes[0]}`}>
            <ol aria-label={block.label} className="flex flex-col">
              {block.indexes.map((index) => {
                const segment = segments[index]!
                return (
                  <SegmentRow
                    key={segment.id}
                    segment={segment}
                    speaker={speakerNameOf(segment.speakerKey, transcript.speakers, meeting.participants)}
                    ranges={hits[index]!}
                    onPlay={
                      audioKept && segment.startMs !== null ? () => audio.current?.playFrom(segment.startMs!) : null
                    }
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
                )
              })}
            </ol>
          </Fragment>
        )
      })}
      {renaming !== null && (
        <SpeakerRenameDialog
          meetingId={meeting.id}
          speaker={transcript.speakers.find((speaker) => speaker.key === renaming)!}
          currentName={speakerNameOf(renaming, transcript.speakers, meeting.participants) ?? ''}
          participants={meeting.participants}
          onClose={() => setRenaming(null)}
          onSaved={(saved) => {
            // A rename changes the label, never which parts the key covers.
            onTranscript({
              ...transcript,
              speakers: transcript.speakers.map((speaker) =>
                speaker.key === saved.key ? { ...speaker, label: saved.label } : speaker,
              ),
            })
            setRenaming(null)
          }}
        />
      )}
      {separating !== null && (
        <SeparateSpeakerDialog
          meetingId={meeting.id}
          speaker={transcript.speakers.find((speaker) => speaker.key === separating)!}
          name={speakerNameOf(separating, transcript.speakers, meeting.participants) ?? ''}
          onSeparated={(speakers) => void afterSeparate(speakers)}
          onStale={() => {
            setSeparating(null)
            setStale(true)
          }}
          onClose={() => setSeparating(null)}
        />
      )}
    </div>
  )
}

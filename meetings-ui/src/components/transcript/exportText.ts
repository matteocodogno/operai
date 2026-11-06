/**
 * exportText — the transcript as plain text (AC-6.6) and the speaker names that text uses.
 *
 * One line per segment: `[hh:mm:ss] Name: text`. A text meeting has no times and no speakers, so
 * its lines are the bare passages. Names are the labels the viewer sees on screen. A transcript marked
 * possibly incomplete begins with the notice and a blank line, and carries a `[Possible gap …]` line
 * where each gap sits on screen (AC-6.6, AC-6.12).
 */
import { formatDuration } from '@operai/ui'
import type { Participant, Speaker, SpeakerLabel, TimeRange, TranscriptSegment } from '../../lib/types'
import { strings } from '../../strings'

const participantName = (participant: Participant | undefined): string | null => {
  if (participant === undefined) return null
  if (participant.kind === 'external') return participant.name
  return participant.person.name ?? strings.transcript.formerPerson
}

/** What a label reads as: "Speaker 2", the participant's name, or the free text. */
export function speakerLabelText(label: SpeakerLabel, participants: Participant[]): string {
  switch (label.kind) {
    case 'default':
      return strings.transcript.speaker(label.index)
    case 'text':
      return label.text
    case 'participant':
      return (
        participantName(participants.find((participant) => participant.id === label.participantId)) ??
        strings.transcript.unknownSpeaker
      )
  }
}

/** The display name for a segment's `speakerKey`, or null when the segment has no speaker. */
export function speakerNameOf(key: string | null, speakers: Speaker[], participants: Participant[]): string | null {
  if (key === null) return null
  const speaker = speakers.find((candidate) => candidate.key === key)
  return speaker === undefined ? strings.transcript.unknownSpeaker : speakerLabelText(speaker.label, participants)
}

/** Segments in transcript order. */
export const inOrder = (segments: TranscriptSegment[]): TranscriptSegment[] =>
  [...segments].sort((a, b) => a.ordinal - b.ordinal)

/** `Kick-off: Acme/2026` → `Kick-off- Acme-2026.txt`: nothing a file system or a download header would reject. */
export function textFileName(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim()
  return `${safe === '' ? fallback : safe}.txt`
}

export const clockOf = (ms: number): string => formatDuration(ms, { style: 'clock' })

/** The notice's ranges as the clock times the viewer reads (AC-6.12 a). */
export const noticeRanges = (gaps: readonly TimeRange[]) =>
  gaps.map((gap) => ({ from: clockOf(gap.startMs), to: clockOf(gap.endMs) }))

/**
 * Where each gap's marker goes (AC-6.12 b): before the first segment (in transcript order) that starts
 * at or after the gap's start, keyed by that segment's index; `segments.length` = after the last one.
 * Markers of one index keep the gaps' order.
 */
export function gapsBefore(segments: readonly TranscriptSegment[], gaps: readonly TimeRange[]): Map<number, TimeRange[]> {
  const placed = new Map<number, TimeRange[]>()
  for (const gap of gaps) {
    const found = segments.findIndex((segment) => segment.startMs !== null && segment.startMs >= gap.startMs)
    const index = found === -1 ? segments.length : found
    placed.set(index, [...(placed.get(index) ?? []), gap])
  }
  return placed
}

export const gapMarkerText = (gap: TimeRange): string =>
  strings.transcript.incomplete.marker(clockOf(gap.startMs), clockOf(gap.endMs))

export function exportText(
  segments: TranscriptSegment[],
  speakers: Speaker[],
  participants: Participant[],
  gaps: readonly TimeRange[] = [],
): string {
  const ordered = inOrder(segments)
  const markers = gapsBefore(ordered, gaps)
  const lines: string[] = []
  const markersAt = (index: number) => {
    for (const gap of markers.get(index) ?? []) lines.push(`[${gapMarkerText(gap)}]`)
  }
  ordered.forEach((segment, index) => {
    markersAt(index)
    const name = speakerNameOf(segment.speakerKey, speakers, participants)
    const head = [
      segment.startMs === null ? null : `[${clockOf(segment.startMs)}]`,
      name === null ? null : `${name}:`,
    ]
      .filter((part): part is string => part !== null)
      .join(' ')
    lines.push(head === '' ? segment.text : `${head} ${segment.text}`)
  })
  markersAt(ordered.length)
  const body = lines.join('\n')
  return gaps.length === 0 ? body : `${strings.transcript.incomplete.notice(noticeRanges(gaps))}\n\n${body}`
}

/** "1–3", "1, 3", "1–2, 4": the parts a joined label covers, runs of consecutive numbers collapsed. */
export function partsText(parts: readonly number[]): string {
  const runs: string[] = []
  let start = 0
  while (start < parts.length) {
    let end = start
    while (end + 1 < parts.length && parts[end + 1] === parts[end]! + 1) end++
    runs.push(end === start ? String(parts[start]) : end === start + 1 ? `${parts[start]}, ${parts[end]}` : `${parts[start]}–${parts[end]}`)
    start = end + 1
  }
  return runs.join(', ')
}

/**
 * exportText — the transcript as plain text (AC-6.6) and the speaker names that text uses.
 *
 * One line per segment: `[hh:mm:ss] Name: text`. A text meeting has no times and no speakers, so
 * its lines are the bare passages. Names are the labels the viewer sees on screen.
 */
import { formatDuration } from '@operai/ui'
import type { Participant, Speaker, SpeakerLabel, TranscriptPart, TranscriptSegment } from '../../lib/types'
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

export function exportText(segments: TranscriptSegment[], speakers: Speaker[], participants: Participant[]): string {
  return inOrder(segments)
    .map((segment) => {
      const name = speakerNameOf(segment.speakerKey, speakers, participants)
      const head = [
        segment.startMs === null ? null : `[${clockOf(segment.startMs)}]`,
        name === null ? null : `${name}:`,
      ]
        .filter((part): part is string => part !== null)
        .join(' ')
      return head === '' ? segment.text : `${head} ${segment.text}`
    })
    .join('\n')
}

const partIndexOf = (segment: TranscriptSegment, parts: readonly TranscriptPart[]): number => {
  const start = segment.startMs
  if (start === null) return -1
  let found = -1
  parts.forEach((part, index) => {
    if (part.startMs <= start) found = index
  })
  return found
}

/**
 * The part that opens at `segments[index]` (AC-6.2): the segment's part, when it differs from the
 * previous segment's and is not the first. Null otherwise. A segment belongs to the last part whose
 * start is at or before its own (times are never later than the speech, G-3), so a part with no
 * segment gets no divider.
 */
export function partStartingAt(
  segments: readonly TranscriptSegment[],
  index: number,
  parts: readonly TranscriptPart[],
): TranscriptPart | null {
  const here = partIndexOf(segments[index]!, parts)
  if (here <= 0) return null
  const before = index === 0 ? -1 : partIndexOf(segments[index - 1]!, parts)
  return here === before ? null : parts[here]!
}

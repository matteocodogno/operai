/**
 * meetingsApi — one typed function per meetings-api route (specs/021-meetings plan.md § API
 * contracts), plus the one `auth` read the participant picker needs. No UI, no state: pages and
 * hooks call these; `api.ts` owns the transport, the Problem mapping and `If-Match`.
 *
 * Reads take an optional `init` (an `AbortSignal`). Every id taken from data is path-encoded, so
 * an id can never change the route it is spliced into. Writes of a versioned record
 * (a transcript segment, a summary, a template) take the `version` they were read at and send it
 * as `If-Match` (ADR-0038, plan G8). Money does not exist here; durations are integer ms and
 * instants are ISO 8601 strings.
 */
import { resolveLocale } from '@operai/ui'
import { getAuthBaseUrl } from 'shell/session'
import { getJson, query, requestJson, sendJson } from './api'
import type {
  ChunkConfirm,
  ConversationTurn,
  DirectoryUser,
  DerivedStatus,
  EraseRow,
  HostInfo,
  HostRef,
  HostView,
  Meeting,
  MeetingFormat,
  MeetingLanguage,
  MeetingRow,
  MeetingSource,
  Page,
  PresignedPost,
  RecordingStart,
  Speaker,
  Summary,
  SummarySection,
  Template,
  TemplateInput,
  Transcript,
  TranscriptSegment,
} from './types'

type Init = RequestInit

const enc = encodeURIComponent
const meetingPath = (id: string) => `/meetings/${enc(id)}`
const hostPath = (app: string, type: string, id: string) => `/hosts/${enc(app)}/${enc(type)}/${enc(id)}`

// ─── Hosts ──────────────────────────────────────────────────────────────────

/** The public part of every registered host: labels (incl. the visibility hint and notice sentence), recommendations. */
export const listHosts = (init?: Init) => getJson<{ items: HostInfo[] }>('/hosts', init)

/** Resolves one host entity as the caller: 422 `host_not_registered` / `host_entity_not_found`, 503 `host_unavailable`. */
export const getHost = (app: string, type: string, id: string, init?: Init) =>
  getJson<{ host: HostView }>(hostPath(app, type, id), init)

/** The caller's own meetings, as creator, that can be linked to this entity (plan G2). */
export const listLinkableMeetings = (
  app: string,
  type: string,
  id: string,
  params: { q?: string; page?: number } = {},
  init?: Init,
) => getJson<Page<MeetingRow>>(`${hostPath(app, type, id)}/linkable-meetings${query(params)}`, init)

/** What the caller may open on this entity; `hostReadersUnavailable` when the host could not be asked (AC-11.2). */
export const listHostMeetings = (app: string, type: string, id: string, params: { page?: number } = {}, init?: Init) =>
  getJson<Page<MeetingRow> & { hostReadersUnavailable?: boolean }>(
    `${hostPath(app, type, id)}/meetings${query(params)}`,
    init,
  )

// ─── Meetings ───────────────────────────────────────────────────────────────

export type MeetingListQuery = {
  q?: string
  role?: 'creator' | 'participant'
  status?: DerivedStatus
  hostApp?: string
  page?: number
}

export const listMeetings = (params: MeetingListQuery = {}, init?: Init) =>
  getJson<Page<MeetingRow>>(`/meetings${query(params)}`, init)

export type CreateMeetingInput = {
  title: string
  format: MeetingFormat
  /** Defaults to now on the server; may be in the past. */
  startsAt?: string
  language: MeetingLanguage
  source: MeetingSource
  host?: HostRef
}

export const createMeeting = (input: CreateMeetingInput) => sendJson<Meeting>('/meetings', 'POST', input)

export const getMeeting = (id: string, init?: Init) => getJson<Meeting>(meetingPath(id), init)

export type MeetingPatch = {
  title?: string
  startsAt?: string
  format?: MeetingFormat
  language?: MeetingLanguage
  source?: MeetingSource
  /** `null` removes the link (AC-1.7). */
  host?: HostRef | null
  hostVisible?: boolean
}

export const updateMeeting = (id: string, patch: MeetingPatch) => sendJson<Meeting>(meetingPath(id), 'PATCH', patch)

/** 204; 503 `storage_unavailable` means nothing was deleted. */
export const deleteMeeting = (id: string) => sendJson<void>(meetingPath(id), 'DELETE')

export type ParticipantInput = { userId: string } | { name: string; organisation?: string }

/** A full replace, at most 30 (AC-5.1). */
export const replaceParticipants = (id: string, participants: ParticipantInput[]) =>
  sendJson<Meeting>(`${meetingPath(id)}/participants`, 'PUT', { participants })

export const confirmConsent = (id: string, noticeVersion: string) =>
  sendJson<Meeting>(`${meetingPath(id)}/consent`, 'POST', { noticeVersion })

export const retryHostNotice = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/host-notice/retry`, 'POST')

// ─── Capture ────────────────────────────────────────────────────────────────

export const startRecording = (id: string) => sendJson<RecordingStart>(`${meetingPath(id)}/recording/start`, 'POST')

export const confirmChunk = (
  id: string,
  seq: number,
  body: { sessionId: string; durationMs: number; capturedMs?: number },
) => sendJson<ChunkConfirm>(`${meetingPath(id)}/recording/chunks/${seq}/confirm`, 'POST', body)

/** Re-mints the policy of a chunk whose five minutes ran out while the tab was offline. */
export const mintChunkUploadUrl = (id: string, seq: number, sessionId: string) =>
  sendJson<PresignedPost>(`${meetingPath(id)}/recording/chunks/${seq}/upload-url`, 'POST', { sessionId })

export const sendHeartbeat = (id: string, body: { sessionId: string; paused: boolean; capturedMs: number }) =>
  sendJson<void>(`${meetingPath(id)}/recording/heartbeat`, 'POST', body)

/** 202 `processing`, or 409 `chunks_missing { missing }` until 0..lastSeq are all stored. */
export const stopRecording = (id: string, body: { sessionId: string; lastSeq: number }) =>
  sendJson<Meeting>(`${meetingPath(id)}/recording/stop`, 'POST', body)

/** Only from `interrupted` (AC-2.8). */
export const processInterrupted = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/recording/process`, 'POST')

export const discardRecording = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/recording/discard`, 'POST')

export const requestUpload = (id: string, body: { contentType: string; sizeBytes: number }) =>
  sendJson<PresignedPost>(`${meetingPath(id)}/upload`, 'POST', body)

/** 202 `processing`; 422 `upload_rejected { reason }` leaves the meeting a draft (AC-3.2). */
export const confirmUpload = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/upload/confirm`, 'POST')

export const saveText = (id: string, text: string) => sendJson<Meeting>(`${meetingPath(id)}/text`, 'PUT', { text })

export const retryProcessing = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/retry`, 'POST')

/** A 15-minute presigned URL; 409 `audio_unavailable` once the audio is gone. */
export const getAudioUrl = (id: string, init?: Init) =>
  getJson<{ url: string; expiresAt: string }>(`${meetingPath(id)}/audio`, init)

export const deleteAudio = (id: string) => sendJson<Meeting>(`${meetingPath(id)}/audio`, 'DELETE')

// ─── Transcript ─────────────────────────────────────────────────────────────

/**
 * The transcript, with the fields of plan H-6 defaulted when a backend that predates them answers: no
 * gaps, labels not separate, rows with no part, labels not joined. The UI then shows what it always did.
 */
export async function getTranscript(id: string, init?: Init): Promise<Transcript> {
  const body = await getJson<Transcript>(`${meetingPath(id)}/transcript`, init)
  return {
    ...body,
    segments: body.segments.map((segment) => ({ ...segment, part: segment.part ?? null })),
    speakers: body.speakers.map(withParts),
    parts: body.parts ?? [],
    gaps: body.gaps ?? [],
    separateLabels: body.separateLabels ?? false,
  }
}

const withParts = (speaker: Speaker): Speaker => ({
  ...speaker,
  parts: speaker.parts ?? [],
  joined: speaker.joined ?? false,
})

/**
 * "Separate by part" (AC-6.16): the lowest part keeps the key, each further part gets its own. 403 for
 * anyone but the creator or on a frozen meeting, 409 `not_ready` / `not_joined`, 404 for an unknown key.
 * Answers the transcript's whole speaker list.
 */
export async function separateSpeaker(id: string, key: string): Promise<{ speakers: Speaker[] }> {
  const body = await sendJson<{ speakers: Speaker[] }>(
    `${meetingPath(id)}/transcript/speakers/${enc(key)}/separate`,
    'POST',
  )
  return { speakers: body.speakers.map(withParts) }
}

/** `version` is the segment's own (`If-Match`); the answer bumps the meeting's `transcriptVersion` (AC-6.3, AC-6.8). */
export const editSegment = (id: string, segmentId: string, version: number, text: string) =>
  sendJson<TranscriptSegment>(`${meetingPath(id)}/transcript/segments/${enc(segmentId)}`, 'PATCH', { text }, version)

/** A participant, free text, or `null` to go back to "Speaker n" (AC-6.2). */
export const setSpeaker = (id: string, key: string, value: { participantId: string } | { text: string } | null) =>
  sendJson<Speaker>(`${meetingPath(id)}/transcript/speakers/${enc(key)}`, 'PUT', value)

// ─── Summaries ──────────────────────────────────────────────────────────────

export const listSummaries = (id: string, init?: Init) =>
  getJson<{ items: Summary[] }>(`${meetingPath(id)}/summaries`, init)

/** 202 with the new (`generating`) summary; 409 `not_ready` / `no_speech` / `summary_limit`, 429 `ai_rate_limited`. */
export const generateSummary = (id: string, body: { templateId: string; language: MeetingLanguage }) =>
  sendJson<Summary>(`${meetingPath(id)}/summaries`, 'POST', body)

export const regenerateSummary = (id: string, summaryId: string) =>
  sendJson<Summary>(`${meetingPath(id)}/summaries/${enc(summaryId)}/regenerate`, 'POST')

export const retrySummary = (id: string, summaryId: string) =>
  sendJson<Summary>(`${meetingPath(id)}/summaries/${enc(summaryId)}/retry`, 'POST')

export const editSummary = (id: string, summaryId: string, version: number, sections: SummarySection[]) =>
  sendJson<Summary>(`${meetingPath(id)}/summaries/${enc(summaryId)}`, 'PATCH', { sections }, version)

export const deleteSummary = (id: string, summaryId: string) =>
  sendJson<void>(`${meetingPath(id)}/summaries/${enc(summaryId)}`, 'DELETE')

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * Recommended-for-the-host first, then personal, shared, built-in (AC-8.5). Built-ins come back in
 * `language` (`Accept-Language`), the page's language unless a caller says otherwise.
 */
export const listTemplates = (
  params: { meetingId?: string } = {},
  options: { language?: MeetingLanguage; signal?: AbortSignal } = {},
) =>
  getJson<{ items: Template[] }>(`/templates${query(params)}`, {
    headers: { 'Accept-Language': options.language ?? resolveLocale() },
    ...(options.signal ? { signal: options.signal } : {}),
  })

export const createTemplate = (input: TemplateInput) => sendJson<Template>('/templates', 'POST', input)

/** `version` is the one `GET /templates` carried (`If-Match`): 428 / 409 `version_conflict` otherwise (plan G8). */
export const updateTemplate = (
  id: string,
  version: number,
  patch: Partial<Pick<TemplateInput, 'name' | 'sections' | 'generalInstructions'>>,
) => sendJson<Template>(`/templates/${enc(id)}`, 'PATCH', patch, version)

export const deleteTemplate = (id: string) => sendJson<void>(`/templates/${enc(id)}`, 'DELETE')

/** A personal copy; for a built-in, in `language` (AC-8.4). */
export const duplicateTemplate = (id: string, language?: MeetingLanguage) =>
  sendJson<Template>(`/templates/${enc(id)}/duplicate`, 'POST', language ? { language } : {})

// ─── Conversation (the caller's own) ────────────────────────────────────────

export const getConversation = (id: string, init?: Init) =>
  getJson<{ turns: ConversationTurn[] }>(`${meetingPath(id)}/conversation`, init)

/** 201 with the turn (`answered` or `failed`; synchronous); 409 `no_speech` / `not_ready`, 429 `ai_rate_limited`. */
export const askQuestion = (id: string, question: string) =>
  sendJson<ConversationTurn>(`${meetingPath(id)}/conversation/questions`, 'POST', { question })

export const retryQuestion = (id: string, turnId: string) =>
  sendJson<ConversationTurn>(`${meetingPath(id)}/conversation/questions/${enc(turnId)}/retry`, 'POST')

export const clearConversation = (id: string) => sendJson<void>(`${meetingPath(id)}/conversation`, 'DELETE')

// ─── Erase (capability meeting:erase) ───────────────────────────────────────

/** Title, date and creator only; no content ever (AC-4.7, AC-4.8). Deleting uses `deleteMeeting`. */
export const listEraseMeetings = (
  params: { q?: string; creatorId?: string; from?: string; to?: string; page?: number } = {},
  init?: Init,
) => getJson<Page<EraseRow>>(`/erase/meetings${query(params)}`, init)

// ─── auth: the user directory (participant picker, ADR-0047 / ADR-0066) ─────

/**
 * Every active user. Deliberately WITHOUT `appId` (plan G9): a participant needs no tool grant
 * (AC-10.4), so everyone must be pickable; ADR-0055's filter would hide people without `meetings`.
 */
export const listDirectory = (init?: Init) =>
  requestJson<{ users: DirectoryUser[] }>(getAuthBaseUrl(), '/authz/users/directory', init)

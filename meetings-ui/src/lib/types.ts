/**
 * Wire types of meetings-api (specs/021-meetings plan.md § API contracts › Conventions).
 *
 * Declarations only, no logic: they mirror the contract so the placeholder cards of T53 can
 * export their final prop types before the data layer (T54) exists. T54 extends this file
 * with the transcript, summary, template, conversation and capture shapes.
 *
 * Instants are ISO 8601 strings; durations are integer milliseconds.
 */

export type PersonRef = { id: string; name: string | null; status: 'active' | 'deleted' | 'unknown' }

export type HostRef = { app: string; entityType: string; entityId: string }

/** A host entity as the caller may see it: `title`/`href` only when `state` is `open`. */
export type HostView = HostRef & {
  state: 'open' | 'closed' | 'missing' | 'unavailable'
  title: string | null
  href: string | null
}

export type Page<T> = { items: T[]; total: number; page: number; pageSize: 25 }

export type DerivedStatus = 'draft' | 'recording' | 'interrupted' | 'processing' | 'ready' | 'failed'

export type MeetingFormat = 'in_person' | 'online'
export type MeetingLanguage = 'en' | 'it'
export type MeetingSource = 'recorded' | 'uploaded' | 'text'

export type PresignedPost = { url: string; fields: Record<string, string>; expiresAt: string }

export type MeetingRow = {
  id: string
  title: string
  startsAt: string
  format: MeetingFormat
  status: DerivedStatus
  host: HostView | null
  role: 'creator' | 'participant'
  summaryCount: number
  creator: PersonRef
}

export type Participant =
  | { id: string; kind: 'operai'; person: PersonRef }
  | { id: string; kind: 'external'; name: string; organisation: string | null }

/** What the caller may do on this meeting, decided by the server (plan G1, G5): the UI never re-derives it. */
export type MeetingCan = {
  edit: boolean
  changeSource: boolean
  changeLanguage: boolean
  manageParticipants: boolean
  link: boolean
  setVisibility: boolean
  capture: boolean
  editTranscript: boolean
  retryProcessing: boolean
  deleteAudio: boolean
  deleteMeeting: boolean
  summarise: boolean
  ask: boolean
  retryHostNotice: boolean
}

export type Meeting = Omit<MeetingRow, 'role'> & {
  language: MeetingLanguage
  source: MeetingSource
  stage: 'preparing' | 'transcribing' | null
  failure: { code: string } | null
  noSpeech: boolean
  durationMs: number | null
  role: 'creator' | 'participant' | 'host_reader'
  /** null = the creator's identity cannot be checked right now (AC-5.11). */
  frozen: boolean | null
  consent: { by: PersonRef; at: string; noticeVersion: string } | null
  participants: Participant[]
  hostVisible: boolean
  hostVisibleOffered: boolean
  audio: { state: 'kept'; until: string } | { state: 'deleted' } | { state: 'none' }
  /** `lostMs` is creator-only: a lower bound of audio lost while offline, or null when unknown (plan G3). */
  recording: { live: boolean; durationMs: number; lostMs: number | null } | null
  /** Creator only: the host did not accept the last notice (AC-11.9, AC-14.8). */
  hostNotice: { state: 'failed'; event: 'linked' | 'changed' } | null
  transcriptVersion: number
  capabilities: 'resolved' | 'unavailable'
  can: MeetingCan
}

/** The public part of a host registration, from `GET /hosts` (plan § Host integration contract). */
export type HostLabels = { app: string; entity: string; visibilityHint: string; noticeFailed: string }

export type HostInfo = {
  app: string
  entityType: string
  labels: Record<'en' | 'it', HostLabels>
  offersHostVisible: boolean
  recommendedTemplates: string[]
}

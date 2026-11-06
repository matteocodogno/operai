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

// ─── Capture (plan § API contracts › Capture) ───────────────────────────────

/** `POST …/recording/start`: the session and the policy for seq 0; each confirm returns the next policy. */
export type RecordingStart = {
  sessionId: string
  chunkSeconds: 10
  maxChunkBytes: number
  next: PresignedPost
}

export type ChunkConfirm = { storedChunks: number; durationMs: number; next: PresignedPost }

// ─── Transcript ─────────────────────────────────────────────────────────────

/** `startMs`/`endMs` are null for a text meeting (passages have no time). */
export type TranscriptSegment = {
  id: string
  ordinal: number
  startMs: number | null
  endMs: number | null
  speakerKey: string | null
  /** 1-based transcript part (AC-6.2); null for a text meeting and for rows older than the parts. */
  part: number | null
  text: string
  edited: boolean
  version: number
}

export type SpeakerLabel =
  | { kind: 'default'; index: number }
  | { kind: 'participant'; participantId: string }
  | { kind: 'text'; text: string }

/**
 * `parts` = the transcript parts the key's segments come from, ascending (`[]` for a text meeting);
 * `joined` = it covers more than one part, matched automatically (AC-6.14, AC-6.16).
 */
export type Speaker = { key: string; label: SpeakerLabel; parts: number[]; joined: boolean }

/**
 * A transcript part (AC-6.2): `index` is 1-based; `startMs`/`endMs` are the audio it covers, in meeting
 * time. Consecutive parts overlap (plan H-1). `[]` for a text meeting or no speech.
 */
export type TranscriptPart = { index: number; startMs: number; endMs: number }

/** A stretch of meeting time where speech may be missing (AC-6.12); ascending, merged, never edited. */
export type TimeRange = { startMs: number; endMs: number }

export type Transcript = {
  version: number
  segments: TranscriptSegment[]
  speakers: Speaker[]
  parts: TranscriptPart[]
  /** `[]` = no notice (AC-6.12). */
  gaps: TimeRange[]
  /** More than one part and at least one label of a later part is separate: the AC-6.15 notice. */
  separateLabels: boolean
}

// ─── Templates ──────────────────────────────────────────────────────────────

export type TemplateSource = 'builtin' | 'shared' | 'personal'

export type TemplateSection = { heading: string; instruction: string }

/** `version` is the `If-Match` precondition of `PATCH /templates/:id` (plan G8). */
export type Template = {
  id: string
  source: TemplateSource
  name: string
  sections: TemplateSection[]
  generalInstructions: string | null
  recommended: boolean
  version: number
}

export type TemplateInput = {
  scope: 'personal' | 'shared'
  name: string
  sections: TemplateSection[]
  generalInstructions?: string
}

// ─── Summaries ──────────────────────────────────────────────────────────────

export type SummaryStatus = 'generating' | 'ready' | 'failed'

/** A `notDiscussed` section carries the server's own text in `body` (AC-7.2). */
export type SummarySection = { heading: string; body: string; notDiscussed?: boolean }

/** `can` is per item (plan G4): the UI never re-derives edit, delete or retry. */
export type Summary = {
  id: string
  template: { name: string; source: TemplateSource }
  language: MeetingLanguage
  author: PersonRef
  status: SummaryStatus
  sections?: SummarySection[]
  edited: boolean
  /** The transcript changed after this summary was made (AC-6.8). */
  stale: boolean
  /** Written by the service from the gaps the summary was made under (AC-7.13); null/absent = none. */
  possiblyIncomplete?: { gaps: TimeRange[] } | null
  createdAt: string
  version: number
  can: { edit: boolean; delete: boolean; retry: boolean }
}

// ─── Conversation ───────────────────────────────────────────────────────────

export type TurnStatus = 'pending' | 'answered' | 'failed'

export type Citation = { segmentId: string; ordinal: number; startMs: number | null; speaker: string | null }

export type ConversationTurn = {
  id: string
  question: string
  status: TurnStatus
  answer: {
    text: string
    notInMeeting: boolean
    citations: Citation[]
    /** The transcript was marked possibly incomplete when this was asked (AC-9.9); absent on older rows. */
    possiblyIncomplete?: boolean
  } | null
  createdAt: string
}

// ─── Erase and the user directory ───────────────────────────────────────────

export type EraseRow = { id: string; title: string; startsAt: string; creator: PersonRef }

/** `auth GET /authz/users/directory`; called WITHOUT `appId` for participants (plan G9, ADR-0066). */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

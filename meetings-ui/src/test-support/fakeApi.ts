/**
 * Test support for every meetings-ui test that talks to meetings-api (specs/021-meetings).
 *
 * `fakeApi` is a URL-dispatching stand-in for `shell/session`'s `apiFetch`: each route is
 * `METHOD /path` (a `:name` segment matches any one path segment and arrives in `params`) →
 * a handler answering `{status, body}`. The request reaches the real `lib/meetingsApi.ts` +
 * `lib/api.ts`, so a page test also exercises the request paths, query strings and headers the
 * contract fixes. An exact route beats a parameterised one. An unrouted request is a 404 Problem,
 * which is also what the server answers for "does not exist" and "not visible" (AC-5.3).
 *
 * The fixtures are typed with the wire types of `lib/types.ts`, so a contract change that is not
 * followed here fails the build, not a test at random. Defaults describe the commonest state (a
 * creator's draft); a test overrides exactly the fields it is about.
 */
import { vi } from 'vitest'
import type {
  ConversationTurn,
  HostInfo,
  HostView,
  Meeting,
  MeetingCan,
  MeetingRow,
  PersonRef,
  Summary,
  Template,
  Transcript,
  TranscriptSegment,
} from '../lib/types'

export type FakeAnswer = { status: number; body?: unknown; headers?: Record<string, string> }
export type FakeParams = Record<string, string>
export type FakeHandler = (
  url: URL,
  init: RequestInit | undefined,
  params: FakeParams,
) => FakeAnswer | Promise<FakeAnswer>

const compile = (pattern: string): { method: string; regex: RegExp; names: string[]; exact: boolean } => {
  const [method = 'GET', path = ''] = pattern.split(' ')
  const names: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { method, regex: new RegExp(`^${source}$`), names, exact: names.length === 0 }
}

export function fakeApi(routes: Record<string, FakeHandler>) {
  // Exact routes first, so `GET /meetings/new` is never read as `GET /meetings/:id`.
  const compiled = Object.entries(routes)
    .map(([pattern, handler]) => ({ ...compile(pattern), handler }))
    .sort((a, b) => Number(b.exact) - Number(a.exact))

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    for (const route of compiled) {
      if (route.method !== method) continue
      const match = route.regex.exec(url.pathname)
      if (!match) continue
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
      const answer = await route.handler(url, init, params)
      return answer.body === undefined
        ? new Response(null, { status: answer.status, headers: answer.headers })
        : new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers })
    }
    return new Response(JSON.stringify(problem(404, 'not_found')), { status: 404 })
  })
}

/** A Problem JSON body (RFC 7807) with the top-level `code` and any extension members. */
export const problem = (status: number, code?: string, extras: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title: `Problem ${status}`,
  status,
  ...(code !== undefined ? { code } : {}),
  ...extras,
})

export const page = <T>(items: T[], total = items.length, pageNumber = 1) => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25 as const,
})

// ─── People ─────────────────────────────────────────────────────────────────

export const ADA: PersonRef = { id: 'u-ada', name: 'Ada Lovelace', status: 'active' }
export const GRACE: PersonRef = { id: 'u-grace', name: 'Grace Hopper', status: 'active' }
export const GONE: PersonRef = { id: 'u-gone', name: null, status: 'deleted' }

// ─── Meetings ───────────────────────────────────────────────────────────────

/** Nothing allowed: a read-only participant, a frozen meeting, or an unresolved capability. */
export const CAN_NONE: MeetingCan = {
  edit: false,
  changeSource: false,
  changeLanguage: false,
  manageParticipants: false,
  link: false,
  setVisibility: false,
  capture: false,
  editTranscript: false,
  retryProcessing: false,
  deleteAudio: false,
  deleteMeeting: false,
  summarise: false,
  ask: false,
  retryHostNotice: false,
}

/** What a creator holding `meetings:access` may do on a fresh draft. */
export const CAN_CREATOR_DRAFT: MeetingCan = {
  ...CAN_NONE,
  edit: true,
  changeSource: true,
  changeLanguage: true,
  manageParticipants: true,
  link: true,
  capture: true,
  deleteMeeting: true,
}

/** What a creator may do on a ready meeting: everything except capture and the source/language locks. */
export const CAN_CREATOR_READY: MeetingCan = {
  ...CAN_NONE,
  edit: true,
  manageParticipants: true,
  link: true,
  editTranscript: true,
  deleteAudio: true,
  deleteMeeting: true,
  summarise: true,
  ask: true,
}

export const meeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  id: 'm1',
  title: 'Kick-off with Acme',
  startsAt: '2026-11-03T09:30:00.000Z',
  format: 'online',
  status: 'draft',
  host: null,
  summaryCount: 0,
  creator: ADA,
  language: 'en',
  source: 'recorded',
  stage: null,
  failure: null,
  noSpeech: false,
  durationMs: null,
  role: 'creator',
  frozen: false,
  consent: null,
  participants: [],
  hostVisible: false,
  hostVisibleOffered: false,
  audio: { state: 'none' },
  recording: null,
  hostNotice: null,
  transcriptVersion: 1,
  capabilities: 'resolved',
  can: CAN_CREATOR_DRAFT,
  ...overrides,
})

/** A ready meeting seen by its creator, with audio kept. */
export const readyMeeting = (overrides: Partial<Meeting> = {}): Meeting =>
  meeting({
    status: 'ready',
    durationMs: 3_600_000,
    consent: { by: ADA, at: '2026-11-03T09:29:00.000Z', noticeVersion: '2026-11-01' },
    audio: { state: 'kept', until: '2026-12-03T09:30:00.000Z' },
    can: CAN_CREATOR_READY,
    ...overrides,
  })

/** A ready meeting seen by an Operai participant: nothing to change, everything to read. */
export const participantMeeting = (overrides: Partial<Meeting> = {}): Meeting =>
  readyMeeting({ role: 'participant', can: CAN_NONE, ...overrides })

export const meetingRow = (overrides: Partial<MeetingRow> = {}): MeetingRow => ({
  id: 'm1',
  title: 'Kick-off with Acme',
  startsAt: '2026-11-03T09:30:00.000Z',
  format: 'online',
  status: 'ready',
  host: null,
  role: 'creator',
  summaryCount: 1,
  creator: ADA,
  ...overrides,
})

// ─── Hosts ──────────────────────────────────────────────────────────────────

/** The CRM deal registration as `GET /hosts` serves it (plan § Host integration contract). */
export const crmDealHost: HostInfo = {
  app: 'crm',
  entityType: 'deal',
  labels: {
    en: {
      app: 'CRM',
      entity: 'Deal',
      visibilityHint: 'and can see deal financials',
      noticeFailed: "The deal's activity could not be added",
    },
    it: {
      app: 'CRM',
      entity: 'Opportunità',
      visibilityHint: "e possono vedere i dati economici dell'opportunità",
      noticeFailed: "Non è stato possibile aggiungere l'attività all'opportunità",
    },
  },
  offersHostVisible: true,
  recommendedTemplates: ['builtin:sales-discovery'],
}

export const hostView = (overrides: Partial<HostView> = {}): HostView => ({
  app: 'crm',
  entityType: 'deal',
  entityId: 'd1',
  state: 'open',
  title: 'Acme renewal',
  href: '/crm/deals/d1',
  ...overrides,
})

// ─── Transcript, summaries, templates, conversation ─────────────────────────

export const segment = (overrides: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg1',
  ordinal: 1,
  startMs: 12_000,
  endMs: 18_000,
  speakerKey: 'spk1',
  text: 'We agreed to ship on Friday.',
  edited: false,
  version: 1,
  ...overrides,
})

export const transcript = (overrides: Partial<Transcript> = {}): Transcript => ({
  version: 1,
  segments: [
    segment(),
    segment({
      id: 'seg2',
      ordinal: 2,
      startMs: 20_000,
      endMs: 25_000,
      speakerKey: 'spk2',
      text: 'Café review on Monday.',
    }),
  ],
  speakers: [
    { key: 'spk1', label: { kind: 'default', index: 1 } },
    { key: 'spk2', label: { kind: 'default', index: 2 } },
  ],
  parts: [{ index: 1, startMs: 0 }],
  ...overrides,
})

/** A three-part transcript (G-11): part 2 starts at 1 h, part 3 at 2 h; speakers are numbered per part. */
export const threePartTranscript = (): Transcript =>
  transcript({
    segments: [
      segment({ id: 'a1', ordinal: 1, startMs: 0, endMs: 5_000, speakerKey: 'p1:1', text: 'Opening of part one.' }),
      segment({ id: 'b1', ordinal: 2, startMs: 3_600_000, endMs: 3_620_000, speakerKey: 'p2:1', text: 'Start of part two.' }),
      segment({ id: 'c1', ordinal: 3, startMs: 7_200_000, endMs: 7_230_000, speakerKey: 'p3:1', text: 'Start of part three.' }),
    ],
    speakers: [
      { key: 'p1:1', label: { kind: 'default', index: 1 } },
      { key: 'p2:1', label: { kind: 'default', index: 2 } },
      { key: 'p3:1', label: { kind: 'default', index: 3 } },
    ],
    parts: [
      { index: 1, startMs: 0 },
      { index: 2, startMs: 3_600_000 },
      { index: 3, startMs: 7_200_000 },
    ],
  })

export const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: 's1',
  template: { name: 'Sales discovery', source: 'builtin' },
  language: 'en',
  author: ADA,
  status: 'ready',
  sections: [
    { heading: 'Decisions', body: 'Ship on Friday.' },
    { heading: 'Risks', body: 'Not discussed.', notDiscussed: true },
  ],
  edited: false,
  stale: false,
  createdAt: '2026-11-03T11:00:00.000Z',
  version: 1,
  can: { edit: true, delete: true, retry: false },
  ...overrides,
})

export const template = (overrides: Partial<Template> = {}): Template => ({
  id: 't1',
  source: 'personal',
  name: 'Weekly sync',
  sections: [
    { heading: 'Decisions', instruction: 'List what was decided.' },
    { heading: 'Actions', instruction: 'Who does what by when.' },
  ],
  generalInstructions: null,
  recommended: false,
  version: 1,
  ...overrides,
})

export const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: 'q1',
  question: 'When do we ship?',
  status: 'answered',
  answer: {
    text: 'On Friday.',
    notInMeeting: false,
    citations: [{ segmentId: 'seg1', ordinal: 1, startMs: 12_000, speaker: 'Speaker 1' }],
  },
  createdAt: '2026-11-03T11:05:00.000Z',
  ...overrides,
})

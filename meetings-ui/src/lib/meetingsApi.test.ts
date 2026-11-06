import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import * as api from './meetingsApi'

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }))
})

type Row = {
  name: keyof typeof api
  call: () => Promise<unknown>
  method: string
  /** Path and query, relative to the meetings-api origin (or the auth origin for the directory). */
  url: string
  body?: unknown
  ifMatch?: string
  /** What the server answers, when the client reads the body (the default is `{}`). */
  reply?: unknown
}

const POST = 'POST'
const PATCH = 'PATCH'
const PUT = 'PUT'
const DELETE = 'DELETE'
const GET = 'GET'

/** One row per exported function: the route table of plan.md § API contracts, as the client sends it. */
const ROWS: Row[] = [
  // Hosts
  { name: 'listHosts', call: () => api.listHosts(), method: GET, url: '/hosts' },
  { name: 'getHost', call: () => api.getHost('crm', 'deal', 'd 1'), method: GET, url: '/hosts/crm/deal/d%201' },
  {
    name: 'listLinkableMeetings',
    call: () => api.listLinkableMeetings('crm', 'deal', 'd1', { q: 'kick', page: 2 }),
    method: GET,
    url: '/hosts/crm/deal/d1/linkable-meetings?q=kick&page=2',
  },
  {
    name: 'listHostMeetings',
    call: () => api.listHostMeetings('crm', 'deal', 'd1', { page: 3 }),
    method: GET,
    url: '/hosts/crm/deal/d1/meetings?page=3',
  },
  // Meetings
  {
    name: 'listMeetings',
    call: () => api.listMeetings({ q: 'plan', role: 'creator', status: 'ready', hostApp: 'crm', page: 2 }),
    method: GET,
    url: '/meetings?q=plan&role=creator&status=ready&hostApp=crm&page=2',
  },
  {
    name: 'createMeeting',
    call: () => api.createMeeting({ title: 'Kick-off', format: 'online', language: 'en', source: 'recorded' }),
    method: POST,
    url: '/meetings',
    body: { title: 'Kick-off', format: 'online', language: 'en', source: 'recorded' },
  },
  { name: 'getMeeting', call: () => api.getMeeting('m1'), method: GET, url: '/meetings/m1' },
  {
    name: 'updateMeeting',
    call: () => api.updateMeeting('m1', { host: null }),
    method: PATCH,
    url: '/meetings/m1',
    body: { host: null },
  },
  { name: 'deleteMeeting', call: () => api.deleteMeeting('m1'), method: DELETE, url: '/meetings/m1' },
  {
    name: 'replaceParticipants',
    call: () => api.replaceParticipants('m1', [{ userId: 'u1' }, { name: 'Eve', organisation: 'Acme' }]),
    method: PUT,
    url: '/meetings/m1/participants',
    body: { participants: [{ userId: 'u1' }, { name: 'Eve', organisation: 'Acme' }] },
  },
  {
    name: 'confirmConsent',
    call: () => api.confirmConsent('m1', '2026-11-01'),
    method: POST,
    url: '/meetings/m1/consent',
    body: { noticeVersion: '2026-11-01' },
  },
  {
    name: 'retryHostNotice',
    call: () => api.retryHostNotice('m1'),
    method: POST,
    url: '/meetings/m1/host-notice/retry',
  },
  // Capture
  { name: 'startRecording', call: () => api.startRecording('m1'), method: POST, url: '/meetings/m1/recording/start' },
  {
    name: 'confirmChunk',
    call: () => api.confirmChunk('m1', 4, { sessionId: 's1', durationMs: 10000, capturedMs: 50000 }),
    method: POST,
    url: '/meetings/m1/recording/chunks/4/confirm',
    body: { sessionId: 's1', durationMs: 10000, capturedMs: 50000 },
  },
  {
    name: 'mintChunkUploadUrl',
    call: () => api.mintChunkUploadUrl('m1', 4, 's1'),
    method: POST,
    url: '/meetings/m1/recording/chunks/4/upload-url',
    body: { sessionId: 's1' },
  },
  {
    name: 'sendHeartbeat',
    call: () => api.sendHeartbeat('m1', { sessionId: 's1', paused: true, capturedMs: 1000 }),
    method: POST,
    url: '/meetings/m1/recording/heartbeat',
    body: { sessionId: 's1', paused: true, capturedMs: 1000 },
  },
  {
    name: 'stopRecording',
    call: () => api.stopRecording('m1', { sessionId: 's1', lastSeq: 9 }),
    method: POST,
    url: '/meetings/m1/recording/stop',
    body: { sessionId: 's1', lastSeq: 9 },
  },
  {
    name: 'processInterrupted',
    call: () => api.processInterrupted('m1'),
    method: POST,
    url: '/meetings/m1/recording/process',
  },
  {
    name: 'discardRecording',
    call: () => api.discardRecording('m1'),
    method: POST,
    url: '/meetings/m1/recording/discard',
  },
  {
    name: 'requestUpload',
    call: () => api.requestUpload('m1', { contentType: 'audio/mpeg', sizeBytes: 1234 }),
    method: POST,
    url: '/meetings/m1/upload',
    body: { contentType: 'audio/mpeg', sizeBytes: 1234 },
  },
  { name: 'confirmUpload', call: () => api.confirmUpload('m1'), method: POST, url: '/meetings/m1/upload/confirm' },
  {
    name: 'saveText',
    call: () => api.saveText('m1', 'hello'),
    method: PUT,
    url: '/meetings/m1/text',
    body: { text: 'hello' },
  },
  { name: 'retryProcessing', call: () => api.retryProcessing('m1'), method: POST, url: '/meetings/m1/retry' },
  { name: 'getAudioUrl', call: () => api.getAudioUrl('m1'), method: GET, url: '/meetings/m1/audio' },
  { name: 'deleteAudio', call: () => api.deleteAudio('m1'), method: DELETE, url: '/meetings/m1/audio' },
  // Transcript
  {
    name: 'getTranscript',
    call: () => api.getTranscript('m1'),
    method: GET,
    url: '/meetings/m1/transcript',
    reply: { version: 1, segments: [], speakers: [], parts: [], gaps: [], separateLabels: false },
  },
  {
    name: 'editSegment',
    call: () => api.editSegment('m1', 'seg1', 3, 'fixed'),
    method: PATCH,
    url: '/meetings/m1/transcript/segments/seg1',
    body: { text: 'fixed' },
    ifMatch: '"3"',
  },
  {
    name: 'setSpeaker',
    call: () => api.setSpeaker('m1', 'spk1', { text: 'Ada' }),
    method: PUT,
    url: '/meetings/m1/transcript/speakers/spk1',
    body: { text: 'Ada' },
  },
  {
    name: 'separateSpeaker',
    call: () => api.separateSpeaker('m1', 'k1'),
    method: POST,
    url: '/meetings/m1/transcript/speakers/k1/separate',
    reply: { speakers: [] },
  },
  // Summaries
  { name: 'listSummaries', call: () => api.listSummaries('m1'), method: GET, url: '/meetings/m1/summaries' },
  {
    name: 'generateSummary',
    call: () => api.generateSummary('m1', { templateId: 't1', language: 'it' }),
    method: POST,
    url: '/meetings/m1/summaries',
    body: { templateId: 't1', language: 'it' },
  },
  {
    name: 'regenerateSummary',
    call: () => api.regenerateSummary('m1', 's1'),
    method: POST,
    url: '/meetings/m1/summaries/s1/regenerate',
  },
  {
    name: 'retrySummary',
    call: () => api.retrySummary('m1', 's1'),
    method: POST,
    url: '/meetings/m1/summaries/s1/retry',
  },
  {
    name: 'editSummary',
    call: () => api.editSummary('m1', 's1', 2, [{ heading: 'Decisions', body: 'None' }]),
    method: PATCH,
    url: '/meetings/m1/summaries/s1',
    body: { sections: [{ heading: 'Decisions', body: 'None' }] },
    ifMatch: '"2"',
  },
  {
    name: 'deleteSummary',
    call: () => api.deleteSummary('m1', 's1'),
    method: DELETE,
    url: '/meetings/m1/summaries/s1',
  },
  // Templates
  {
    name: 'listTemplates',
    call: () => api.listTemplates({ meetingId: 'm1' }),
    method: GET,
    url: '/templates?meetingId=m1',
  },
  {
    name: 'createTemplate',
    call: () =>
      api.createTemplate({
        scope: 'shared',
        name: 'Weekly',
        sections: [{ heading: 'Notes', instruction: 'Key points' }],
      }),
    method: POST,
    url: '/templates',
    body: { scope: 'shared', name: 'Weekly', sections: [{ heading: 'Notes', instruction: 'Key points' }] },
  },
  {
    name: 'updateTemplate',
    call: () => api.updateTemplate('t1', 5, { name: 'Renamed' }),
    method: PATCH,
    url: '/templates/t1',
    body: { name: 'Renamed' },
    ifMatch: '"5"',
  },
  { name: 'deleteTemplate', call: () => api.deleteTemplate('t1'), method: DELETE, url: '/templates/t1' },
  {
    name: 'duplicateTemplate',
    call: () => api.duplicateTemplate('t1', 'it'),
    method: POST,
    url: '/templates/t1/duplicate',
    body: { language: 'it' },
  },
  // Conversation
  { name: 'getConversation', call: () => api.getConversation('m1'), method: GET, url: '/meetings/m1/conversation' },
  {
    name: 'askQuestion',
    call: () => api.askQuestion('m1', 'What was decided?'),
    method: POST,
    url: '/meetings/m1/conversation/questions',
    body: { question: 'What was decided?' },
  },
  {
    name: 'retryQuestion',
    call: () => api.retryQuestion('m1', 'q1'),
    method: POST,
    url: '/meetings/m1/conversation/questions/q1/retry',
  },
  {
    name: 'clearConversation',
    call: () => api.clearConversation('m1'),
    method: DELETE,
    url: '/meetings/m1/conversation',
  },
  // Erase
  {
    name: 'listEraseMeetings',
    call: () => api.listEraseMeetings({ q: 'old', creatorId: 'u1', from: '2026-01-01', to: '2026-02-01', page: 2 }),
    method: GET,
    url: '/erase/meetings?q=old&creatorId=u1&from=2026-01-01&to=2026-02-01&page=2',
  },
]

describe('every exported function is covered by this table', () => {
  it('lists each function of the client exactly once (a new route without a row fails here)', () => {
    const exported = Object.keys(api).filter((key) => typeof api[key as keyof typeof api] === 'function')
    const withRows = ROWS.map((row) => row.name)
    expect(withRows.sort()).toEqual([...exported.filter((name) => name !== 'listDirectory')].sort())
  })
})

describe('the plan route table', () => {
  it.each(ROWS)('$name sends $method $url', async ({ call, method, url, body, ifMatch, reply }) => {
    if (reply !== undefined) {
      vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify(reply), { status: 200 }))
    }
    await call()
    const [target, init] = vi.mocked(apiFetch).mock.calls[0]! as [string, RequestInit | undefined]
    expect(target).toBe(`http://meetings-api.test${url}`)
    expect(init?.method ?? 'GET').toBe(method)
    if (body !== undefined) expect(JSON.parse(init!.body as string)).toEqual(body)
    else expect(init?.body).toBeUndefined()
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['If-Match']).toBe(ifMatch)
  })

  it('answers with the parsed JSON body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ id: 'm1' }), { status: 200 }))
    await expect(api.getMeeting('m1')).resolves.toEqual({ id: 'm1' })
  })

  it('a transcript from a backend that predates plan H-6 reads as no gaps, no separate labels, no parts', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 2,
          segments: [{ id: 's1', ordinal: 1, startMs: 0, endMs: 1, speakerKey: 'a', text: 'Hi', edited: false, version: 1 }],
          speakers: [{ key: 'a', label: { kind: 'default', index: 1 } }],
        }),
        { status: 200 },
      ),
    )
    const transcript = await api.getTranscript('m1')
    expect(transcript.gaps).toEqual([])
    expect(transcript.separateLabels).toBe(false)
    expect(transcript.parts).toEqual([])
    expect(transcript.segments[0]!.part).toBeNull()
    expect(transcript.speakers[0]).toMatchObject({ parts: [], joined: false })
  })

  it('a bodyless 204 (delete) resolves undefined', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(api.deleteMeeting('m1')).resolves.toBeUndefined()
  })

  it('passes the AbortSignal of a read through to apiFetch', async () => {
    const controller = new AbortController()
    await api.getMeeting('m1', { signal: controller.signal })
    expect((vi.mocked(apiFetch).mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal)
  })

  it('encodes every path segment taken from data (an id with a slash cannot change the route)', async () => {
    await api.getMeeting('a/../b')
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('http://meetings-api.test/meetings/a%2F..%2Fb')
  })
})

describe('listTemplates sends the UI language so built-ins come back localised (AC-8.5)', () => {
  it('as Accept-Language, taken from the resolved locale', async () => {
    await api.listTemplates({}, { language: 'it' })
    const init = vi.mocked(apiFetch).mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Accept-Language']).toBe('it')
  })

  it('defaults to the page language (English under the test browser)', async () => {
    await api.listTemplates({})
    const init = vi.mocked(apiFetch).mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Accept-Language']).toBe('en')
  })
})

describe('listDirectory (the participant picker, plan G9)', () => {
  it('reads auth, not meetings-api', async () => {
    await api.listDirectory()
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('http://auth.test/authz/users/directory')
  })

  it('never narrows by appId: a participant needs no tool grant (AC-10.4)', async () => {
    await api.listDirectory()
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).not.toContain('appId')
  })
})

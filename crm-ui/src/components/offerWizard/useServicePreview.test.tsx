/**
 * @vitest-environment jsdom
 *
 * The wizard's request discipline for the service's pages (specs/20261116-letterhead-service T32; design F12, F13;
 * AC-10.3, AC-10.4, AC-10.7, AC-10.8): the body asked, the debounce, the previous pages kept, a stale answer discarded,
 * the failures told apart, and nothing asked for a preview that is not on screen.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import type { ServicePreviewAnswer } from '../../lib/crmApi'
import { initialAnswers, sampleContext, setField, type WizardAnswers } from '../../lib/offerEngine/answers'
import { parseTemplate } from '../../lib/offerEngine/syntax'
import { noticeOf, SERVICE_PREVIEW_DEBOUNCE_MS, useServicePreview, type ServicePreviewSource } from './useServicePreview'

const SOURCE = `@@salutation Dear

## SCOPE
@@step scope
We deliver [OGGETTO].

@@field OGGETTO
label: Object
`

const ast = parseTemplate(SOURCE).ast
const base = initialAnswers(ast, { ...sampleContext('en'), estimate: null })
const typed = (text: string): WizardAnswers => setField(ast, base, 'OGGETTO', text)

const answerOf = (...texts: string[]): ServicePreviewAnswer => ({
  letterheadVersion: 3,
  pageCount: texts.length,
  missingPlaceholders: [],
  unprintableCharacters: 0,
  pages: texts.map((text, index) => ({ n: index + 1, image: `png-${text}`, text })),
  missingFields: [],
})

const problem = (status: number, code: string, extras: Record<string, unknown> = {}, retryAfterSeconds?: number) =>
  new ApiError({ status, title: code, code, extras, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) })

type Ask = ServicePreviewSource['ask']
const sourceOf = (ask: Ask, identity = 'deal-1:4:new'): ServicePreviewSource => ({ entity: 'welld_it', identity, ask })

type Props = { source: ServicePreviewSource | undefined; answers: WizardAnswers; asking: boolean }
const mount = (initial: Props) => renderHook((props: Props) => useServicePreview(props), { initialProps: initial })

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useServicePreview — what is asked (AC-10.3)', () => {
  it('asks at once the first time, with the unsaved answers and not the step the person is on', async () => {
    const ask = vi.fn<Ask>().mockResolvedValue(answerOf('one', 'two'))
    const { result } = mount({ source: sourceOf(ask), answers: { ...typed('Website'), lastStep: 'costs' }, asking: true })
    expect(result.current.state).toBe('loading')
    expect(result.current.pages).toEqual([])
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toEqual({ ...typed('Website'), lastStep: 'client' })
    expect(ask.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(result.current.state).toBe('ready')
    expect(result.current.pages).toEqual([
      { image: 'png-one', text: 'one' },
      { image: 'png-two', text: 'two' },
    ])
    expect(result.current.notice).toBeNull()
  })

  it('does not ask again when only the step changed', async () => {
    const ask = vi.fn<Ask>().mockResolvedValue(answerOf('one'))
    const { rerender } = mount({ source: sourceOf(ask), answers: { ...base, lastStep: 'client' }, asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: { ...base, lastStep: 'costs' }, asking: true })
    await settle(1000)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks again when what the request is about changes (the template version, the target), not only the answers', async () => {
    const ask = vi.fn<Ask>().mockResolvedValue(answerOf('one'))
    const { rerender } = mount({ source: sourceOf(ask, 'deal-1:4:new'), answers: base, asking: true })
    await settle()
    rerender({ source: sourceOf(ask, 'deal-1:5:new'), answers: base, asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})

describe('useServicePreview — following the draft (AC-10.4)', () => {
  it('waits 250 ms after the last change, keeping the previous pages meanwhile and after', async () => {
    const ask = vi.fn<Ask>().mockResolvedValueOnce(answerOf('old')).mockResolvedValueOnce(answerOf('new'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    expect(result.current.pages.map((page) => page.text)).toEqual(['old'])

    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(100)
    rerender({ source: sourceOf(ask), answers: typed('abc'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS - 1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('updating')
    expect(result.current.pages.map((page) => page.text)).toEqual(['old'])

    await settle(1)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]![0]).toEqual({ ...typed('abc'), lastStep: 'client' })
    expect(result.current.pages.map((page) => page.text)).toEqual(['new'])
    expect(result.current.state).toBe('ready')
  })

  it('aborts the superseded request and discards its late answer', async () => {
    const answers: ((value: ServicePreviewAnswer) => void)[] = []
    const signals: AbortSignal[] = []
    const ask = vi.fn<Ask>().mockImplementation(
      (_answers, signal) =>
        new Promise<ServicePreviewAnswer>((resolve) => {
          signals.push(signal)
          answers.push(resolve)
        }),
    )
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    await act(async () => answers[1]!(answerOf('second')))
    await act(async () => answers[0]!(answerOf('first')))
    expect(result.current.pages.map((page) => page.text)).toEqual(['second'])
    expect(result.current.state).toBe('ready')
  })
})

describe('useServicePreview — when it cannot be made (AC-10.7)', () => {
  it('keeps the last pages and says it failed; Try again asks at once', async () => {
    const ask = vi
      .fn<Ask>()
      .mockResolvedValueOnce(answerOf('kept'))
      .mockRejectedValueOnce(problem(503, 'layout_service_unavailable'))
      .mockResolvedValueOnce(answerOf('back'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(result.current.state).toBe('failed')
    expect(result.current.notice).toEqual({ kind: 'failed' })
    expect(result.current.pages.map((page) => page.text)).toEqual(['kept'])

    act(() => result.current.retry())
    await settle()
    expect(ask).toHaveBeenCalledTimes(3)
    expect(result.current.state).toBe('ready')
    expect(result.current.notice).toBeNull()
    expect(result.current.pages.map((page) => page.text)).toEqual(['back'])
  })

  it('has no pages and says so when the very first request fails (a network failure is a failure too)', async () => {
    const ask = vi.fn<Ask>().mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = mount({ source: sourceOf(ask), answers: base, asking: true })
    await settle()
    expect(result.current.state).toBe('failed')
    expect(result.current.pages).toEqual([])
    expect(result.current.notice).toEqual({ kind: 'failed' })
  })

  it('asks once more after the Retry-After of a busy service, then gives up', async () => {
    const ask = vi
      .fn<Ask>()
      .mockResolvedValueOnce(answerOf('kept'))
      .mockRejectedValueOnce(problem(503, 'layout_service_unavailable', {}, 3))
      .mockRejectedValueOnce(problem(503, 'layout_service_unavailable', {}, 3))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('updating')
    expect(result.current.notice).toBeNull()

    await settle(2999)
    expect(ask).toHaveBeenCalledTimes(2)
    await settle(1)
    expect(ask).toHaveBeenCalledTimes(3)
    await settle(10_000)
    expect(ask).toHaveBeenCalledTimes(3) // one automatic retry only
    expect(result.current.state).toBe('failed')
    expect(result.current.pages.map((page) => page.text)).toEqual(['kept'])
  })

  it('waits out repeated 429 preview_busy quietly, asks with the LATEST answers, and ends ready with fresh pages (D1)', async () => {
    const busy = () => problem(429, 'preview_busy', {}, 1)
    const ask = vi
      .fn<Ask>()
      .mockResolvedValueOnce(answerOf('kept'))
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(answerOf('fresh'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('updating')
    expect(result.current.notice).toBeNull()
    expect(result.current.pages.map((page) => page.text)).toEqual(['kept'])

    await settle(999)
    expect(ask).toHaveBeenCalledTimes(2) // it waits the Retry-After of 1 s
    await settle(1)
    expect(ask).toHaveBeenCalledTimes(3)
    expect(result.current.state).toBe('updating')
    expect(result.current.notice).toBeNull()
    await settle(1000)
    expect(ask).toHaveBeenCalledTimes(4)
    expect(result.current.state).toBe('ready')
    expect(result.current.notice).toBeNull()
    expect(result.current.pages.map((page) => page.text)).toEqual(['fresh'])
    expect(ask.mock.calls[3]![0]).toEqual(ask.mock.calls[1]![0])
  })

  it('re-asks a busy 429 with what was typed meanwhile, not with the answers that were refused', async () => {
    const ask = vi
      .fn<Ask>()
      .mockResolvedValueOnce(answerOf('kept'))
      .mockRejectedValueOnce(problem(429, 'preview_busy', {}, 1))
      .mockResolvedValueOnce(answerOf('latest'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    rerender({ source: sourceOf(ask), answers: typed('abc'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS + 1000)
    expect(result.current.state).toBe('ready')
    const last = ask.mock.calls[ask.mock.calls.length - 1]![0]
    expect(last.fields['OGGETTO']).toBe('abc')
  })

  it('shows the notice only when the 429 busy lasts past the 4th attempt, and keeps the pages', async () => {
    const ask = vi.fn<Ask>().mockResolvedValueOnce(answerOf('kept')).mockRejectedValue(problem(429, 'preview_busy', {}, 1))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    for (const calls of [2, 3, 4]) {
      expect(ask).toHaveBeenCalledTimes(calls) // attempts 1..3 of the new input
      expect(result.current.notice).toBeNull()
      expect(result.current.state).toBe('updating')
      await settle(1000)
    }
    expect(ask).toHaveBeenCalledTimes(5) // the 4th attempt
    expect(result.current.state).toBe('failed')
    expect(result.current.notice).toEqual({ kind: 'failed' })
    expect(result.current.pages.map((page) => page.text)).toEqual(['kept'])
    await settle(20_000)
    expect(ask).toHaveBeenCalledTimes(5)
  })

  it('waits a default second for a 429 preview_busy without a Retry-After', async () => {
    const ask = vi.fn<Ask>().mockRejectedValueOnce(problem(429, 'preview_busy')).mockResolvedValueOnce(answerOf('fresh'))
    const { result } = mount({ source: sourceOf(ask), answers: base, asking: true })
    await settle(999)
    expect(ask).toHaveBeenCalledTimes(1)
    await settle(1)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('ready')
  })

  it('does not retry a 429 that is not preview_busy', async () => {
    const ask = vi.fn<Ask>().mockRejectedValue(problem(429, 'rate_limited', {}, 1))
    const { result } = mount({ source: sourceOf(ask), answers: base, asking: true })
    await settle(20_000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('failed')
  })

  it('does not retry a 503 that says nothing about waiting', async () => {
    const ask = vi.fn<Ask>().mockRejectedValue(problem(503, 'layout_service_unavailable'))
    const { result } = mount({ source: sourceOf(ask), answers: base, asking: true })
    await settle(20_000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('failed')
  })

  it('asks again on the next change after a refusal, which is not retried by itself', async () => {
    const ask = vi
      .fn<Ask>()
      .mockRejectedValueOnce(problem(422, 'answers_invalid', { path: 'fields.OGGETTO' }))
      .mockResolvedValueOnce(answerOf('fine'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('bad'), asking: true })
    await settle(20_000)
    expect(result.current.state).toBe('blocked')
    expect(result.current.notice).toEqual({ kind: 'invalid' })
    expect(ask).toHaveBeenCalledTimes(1)
    rerender({ source: sourceOf(ask), answers: typed('good'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(result.current.state).toBe('ready')
    expect(result.current.notice).toBeNull()
  })
})

describe('noticeOf — the refusals the preview route has (T28)', () => {
  it.each([
    [problem(409, 'letterhead_not_configured'), { kind: 'notConfigured' }],
    [problem(409, 'letterhead_overflow', { frame: 'footer', entity: 'welld_it' }), { kind: 'overflow', frame: 'footer' }],
    [problem(409, 'letterhead_overflow', { frame: 'header', entity: 'welld_ch' }), { kind: 'overflow', frame: 'header' }],
    [
      problem(409, 'legal_entity_incomplete', { entity: 'welld_ch', missing: ['vatNumber', 'address.en'] }),
      { kind: 'legalEntityIncomplete', entity: 'welld_ch', missing: ['vatNumber', 'address.en'] },
    ],
    [problem(409, 'legal_entity_incomplete'), { kind: 'legalEntityIncomplete', entity: null, missing: [] }],
    [problem(409, 'legal_entity_incomplete', { entity: 'welld_xx', missing: 'x' }), { kind: 'legalEntityIncomplete', entity: null, missing: [] }],
    // the code of a document path that is gone (E4) is a failure like any other one now
    [problem(409, 'entity_profile_missing'), { kind: 'failed' }],
    [problem(503, 'legal_entities_unavailable'), { kind: 'failed' }],
    [problem(422, 'answers_invalid'), { kind: 'invalid' }],
    [
      problem(422, 'section_too_long', { sections: [{ name: 'section:SCOPE#0', label: 'SCOPE' }] }),
      { kind: 'sectionTooLong', sections: ['SCOPE'] },
    ],
    [
      problem(422, 'section_too_long', {
        sections: [
          { name: 'section:A#0', label: 'A' },
          { name: 'opening', label: null },
          { name: 'section:A#1', label: 'A' },
          { name: 'section:B#0', label: 'B' },
        ],
      }),
      { kind: 'sectionTooLong', sections: ['A', 'B'] },
    ],
    [problem(422, 'section_too_long'), { kind: 'sectionTooLong', sections: [] }],
    [problem(503, 'layout_service_unavailable'), { kind: 'failed' }],
    [problem(404, 'draft_not_found'), { kind: 'failed' }],
    [problem(409, 'template_format_mismatch'), { kind: 'failed' }],
    [new TypeError('Failed to fetch'), { kind: 'failed' }],
  ])('%#: %j', (error, notice) => {
    expect(noticeOf(error)).toEqual(notice)
  })

  it('keeps the pages and does not offer a retry of itself for a 409 or 422: the state is blocked', async () => {
    const ask = vi
      .fn<Ask>()
      .mockResolvedValueOnce(answerOf('kept'))
      .mockRejectedValueOnce(problem(409, 'letterhead_not_configured'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(result.current.state).toBe('blocked')
    expect(result.current.notice).toEqual({ kind: 'notConfigured' })
    expect(result.current.pages.map((page) => page.text)).toEqual(['kept'])
  })
})

describe('useServicePreview — a preview that is not on screen', () => {
  it('asks nothing until a preview is first shown, and shows no pages and no busy state meanwhile', async () => {
    const ask = vi.fn<Ask>().mockResolvedValue(answerOf('one'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: base, asking: false })
    await settle(5000)
    expect(ask).not.toHaveBeenCalled()
    expect(result.current.state).toBe('ready')
    expect(result.current.pages).toEqual([])

    rerender({ source: sourceOf(ask), answers: base, asking: true })
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.pages.map((page) => page.text)).toEqual(['one'])
  })

  it('keeps its answer when hidden and asks again on reopening only if the draft changed', async () => {
    const ask = vi.fn<Ask>().mockResolvedValueOnce(answerOf('one')).mockResolvedValueOnce(answerOf('two'))
    const { result, rerender } = mount({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle()

    // closed, nothing changed: reopened at once with the same answer, nothing asked
    rerender({ source: sourceOf(ask), answers: typed('a'), asking: false })
    await settle(1000)
    rerender({ source: sourceOf(ask), answers: typed('a'), asking: true })
    await settle(1000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('ready')
    expect(result.current.pages.map((page) => page.text)).toEqual(['one'])

    // closed while the draft changes: still nothing asked, the last answer is what reopening shows first
    rerender({ source: sourceOf(ask), answers: typed('a'), asking: false })
    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: false })
    await settle(2000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current.pages.map((page) => page.text)).toEqual(['one'])

    rerender({ source: sourceOf(ask), answers: typed('ab'), asking: true })
    expect(result.current.state).toBe('updating')
    expect(result.current.pages.map((page) => page.text)).toEqual(['one'])
    await settle(SERVICE_PREVIEW_DEBOUNCE_MS)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.current.pages.map((page) => page.text)).toEqual(['two'])
  })

  it('asks nothing without a source (the old path)', async () => {
    const { result } = mount({ source: undefined, answers: base, asking: true })
    await settle(5000)
    expect(result.current.state).toBe('ready')
    expect(result.current.pages).toEqual([])
    expect(result.current.notice).toBeNull()
  })
})

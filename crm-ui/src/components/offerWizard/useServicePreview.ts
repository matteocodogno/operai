import { useMemo, useRef, useState } from 'react'
import { LatestResultBusyError, useLatestResult, type PagePreviewState, type PreviewPage } from '@operai/ui'
import { ApiError } from '../../lib/api'
import type { ServicePreviewAnswer } from '../../lib/crmApi'
import type { WizardAnswers } from '../../lib/offerEngine/answers'
import { legalEntityIncompleteOf } from '../../lib/offerErrors'
import type { Entity } from '../../lib/types'

/** The wizard's debounce before it asks again (design F12.2). */
export const SERVICE_PREVIEW_DEBOUNCE_MS = 250

/** What the page gives the wizard to make the service's preview of a draft (a deal's, or later a template's). */
export interface ServicePreviewSource {
  /** The entity whose letterhead the pages are drawn on: named in the notices, and in the link. */
  entity: Entity
  /**
   * Whatever besides the answers decides what is asked (the deal, the template version, the target), as a string: a
   * change of it asks again, as a change of the answers does.
   */
  identity: string
  /** Asks the service for the pages of the UNSAVED `answers`; throws `ApiError` as the route answers. */
  ask: (answers: WizardAnswers, signal: AbortSignal) => Promise<ServicePreviewAnswer>
}

/** Why there is a notice instead of, or beside, the pages. */
export type ServicePreviewNotice =
  /** 503 `layout_service_unavailable`, a network failure or anything unexpected: worth asking again. */
  | { kind: 'failed' }
  /** 409 `letterhead_not_configured` (AC-10.8). */
  | { kind: 'notConfigured' }
  /** 409 `letterhead_overflow` (T27): a profile value does not fit the header or the footer. */
  | { kind: 'overflow'; frame: 'header' | 'footer' }
  /**
   * 409 `legal_entity_incomplete` (specs/20261117-legal-entities AC-6.3): the registry says the issuer's details are not all
   * filled in. `entity` is the one the body names (null when it names none we know); `missing` is what it lists.
   */
  | { kind: 'legalEntityIncomplete'; entity: Entity | null; missing: readonly string[] }
  /** 422 `answers_invalid`: the draft holds an answer the engine refuses; the next change asks again. */
  | { kind: 'invalid' }
  /**
   * 422 `section_too_long` (T50): a section prints more than 20 000 characters, which generate refuses too. `sections`
   * holds the template's headings of the sections named (an opening or an annex has none, so it can be empty).
   */
  | { kind: 'sectionTooLong'; sections: readonly string[] }

export type ServicePreviewResult = {
  state: PagePreviewState
  pages: readonly PreviewPage[]
  notice: ServicePreviewNotice | null
  /** Asks again now (the notice's **Try again**). */
  retry: () => void
}

/** The wait of a 503 that says it is busy and not when to come back: what crm-api's own client takes as its default. */
const DEFAULT_BUSY_WAIT_MS = 2_000

/** The headings the 422 names (`extras.sections[].label`): text only, once each; anything else the route would not send is ignored. */
function sectionHeadings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const headings = value.flatMap((entry: unknown) => {
    const label = typeof entry === 'object' && entry !== null ? (entry as { label?: unknown }).label : undefined
    return typeof label === 'string' && label.trim() !== '' ? [label.trim()] : []
  })
  return [...new Set(headings)]
}

/** A failure as the pane tells it (AC-10.7, AC-10.8). */
export function noticeOf(error: unknown): ServicePreviewNotice {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'letterhead_not_configured') return { kind: 'notConfigured' }
    if (error.status === 409 && error.code === 'letterhead_overflow') {
      return { kind: 'overflow', frame: error.extras['frame'] === 'footer' ? 'footer' : 'header' }
    }
    const incomplete = legalEntityIncompleteOf(error)
    if (incomplete) return { kind: 'legalEntityIncomplete', ...incomplete }
    if (error.status === 422 && error.code === 'answers_invalid') return { kind: 'invalid' }
    if (error.status === 422 && error.code === 'section_too_long') {
      return { kind: 'sectionTooLong', sections: sectionHeadings(error.extras['sections']) }
    }
  }
  return { kind: 'failed' }
}

/** How many times a 503 `busy` is asked again: one automatic retry (design F13). */
const MAX_503_RETRIES = 1
/**
 * How many times crm-api's per-person cap (429 `preview_busy`) is waited out: a busy state, not a failure. The notice
 * appears when it still holds on the 4th attempt (the first ask and these three retries; design F13, T51).
 */
const MAX_PREVIEW_BUSY_RETRIES = 3
/** The wait of a 429 `preview_busy` that does not say when to come back: crm-api's own `Retry-After`. */
const DEFAULT_PREVIEW_BUSY_WAIT_MS = 1_000

type Busy = { error: LatestResultBusyError; kind: '503' | '429' }

/**
 * `busy` is an answer that says "come back later", and the previous pages stay meanwhile (design F13): a 503 that says
 * when to come back (or names `busy` as its reason), asked once more; or crm-api's 429 `preview_busy` (the person's cap
 * of previews in flight), waited out and asked again with the latest answers. Anything else is a failure.
 */
function busyOf(error: unknown): Busy | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 429 && error.code === 'preview_busy') {
    const wait = error.retryAfterSeconds === null ? DEFAULT_PREVIEW_BUSY_WAIT_MS : error.retryAfterSeconds * 1000
    return { error: new LatestResultBusyError(wait), kind: '429' }
  }
  if (error.status !== 503) return null
  if (error.retryAfterSeconds !== null) return { error: new LatestResultBusyError(error.retryAfterSeconds * 1000), kind: '503' }
  return error.extras['reason'] === 'busy' ? { error: new LatestResultBusyError(DEFAULT_BUSY_WAIT_MS), kind: '503' } : null
}

/** The answers as the preview asks them: the step the person is on is not part of what is drawn. */
const askedAnswers = (answers: WizardAnswers): WizardAnswers => ({ ...answers, lastStep: 'client' })

/** What a request is about: the source's identity and the answers; `NOTHING` while there is no source. */
type Asked = { identity: string | null; answers: WizardAnswers | null }
const NOTHING: Asked = { identity: null, answers: null }

/**
 * useServicePreview — the wizard's request discipline for the service's pages (design F12, F13; AC-10.3, AC-10.4, AC-10.7).
 *
 * It is `useLatestResult` over the draft: one request 250 ms after the last change, an older one aborted, a stale answer
 * discarded, the previous pages kept while the next is made or when it fails. It is called ONCE by the wizard, above both
 * slots of the pane, so the last answer survives the Drawer being closed.
 *
 * `asking` says whether a preview is on screen to be kept up to date: a hidden Drawer asks nothing, and reopening it asks
 * again only if the draft changed meanwhile. The first request waits for the first time a preview is shown.
 */
export function useServicePreview({
  source,
  answers,
  asking,
}: {
  source: ServicePreviewSource | undefined
  answers: WizardAnswers
  asking: boolean
}): ServicePreviewResult {
  // On the old path nothing is asked, so the answers (up to 512 KiB) are neither copied nor serialised on every render.
  const live: Asked = source ? { identity: source.identity, answers: askedAnswers(answers) } : NOTHING
  const signature = source ? JSON.stringify(live) : ''

  // What was asked the last time a preview was on screen: a preview that is not on screen asks about nothing newer.
  const [held, setHeld] = useState<{ signature: string; input: Asked }>({ signature, input: live })
  if (asking && held.signature !== signature) setHeld({ signature, input: live })
  const input = asking ? live : held.input

  // The first request is made when a preview is first shown; after that the pane keeps its answer when it is hidden.
  const [started, setStarted] = useState(asking)
  if (asking && !started) setStarted(true)

  // `useLatestResult` has one busy budget; the 503's is smaller than the 429's, so the busy answers in a row are counted here.
  const askedSignature = asking ? signature : held.signature
  const busyRun = useRef<{ signature: string; kind: Busy['kind'] | null; count: number }>({
    signature: askedSignature,
    kind: null,
    count: 0,
  })

  const { status, result, error, retry } = useLatestResult(
    input,
    async (asked, signal) => {
      const run = busyRun.current
      if (run.signature !== askedSignature) busyRun.current = { signature: askedSignature, kind: null, count: 0 }
      try {
        const answer = await source!.ask(asked.answers!, signal)
        busyRun.current = { signature: askedSignature, kind: null, count: 0 }
        return answer
      } catch (failure) {
        if (signal.aborted) throw failure
        const busy = busyOf(failure)
        const before = busyRun.current
        const count = busy !== null && before.kind === busy.kind ? before.count + 1 : 1
        const budget = busy?.kind === '429' ? MAX_PREVIEW_BUSY_RETRIES : MAX_503_RETRIES
        if (busy === null || count > budget) {
          busyRun.current = { signature: askedSignature, kind: null, count: 0 } // given up: the next try (Try again) has its whole budget
          throw failure
        }
        busyRun.current = { signature: askedSignature, kind: busy.kind, count }
        throw busy.error
      }
    },
    {
      enabled: source !== undefined && started,
      debounceMs: SERVICE_PREVIEW_DEBOUNCE_MS,
      maxBusyRetries: Math.max(MAX_503_RETRIES, MAX_PREVIEW_BUSY_RETRIES),
    },
  )

  const pages = useMemo<readonly PreviewPage[]>(
    () => (result ? result.pages.map(({ image, text }) => ({ image, text })) : []),
    [result],
  )

  const notice = status === 'failed' ? noticeOf(error) : null
  const state: PagePreviewState =
    status === 'pending'
      ? pages.length > 0
        ? 'updating'
        : 'loading'
      : status === 'failed'
        ? notice?.kind === 'failed'
          ? 'failed'
          : 'blocked'
        : 'ready'
  return { state, pages, notice, retry }
}

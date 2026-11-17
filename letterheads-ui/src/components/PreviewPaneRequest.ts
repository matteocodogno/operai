/**
 * The request behind the live preview (task T22; design F3, F4; AC-8.4, 8.5, 8.6, 5.8; plan § Person routes,
 * amendment G6): `POST /v1/letterheads/{entity}/preview` with `{ config, language, layoutVersion? }`, the form
 * as it is now, saved or not.
 *
 * The service kills the worker of a preview request that is aborted, so an edit must NOT abort the request
 * in flight: it lets it finish and discards its answer by sequence id. `useLatestResult` already discards
 * every answer but the newest one, but it hands each fetcher a signal it aborts on every edit; the fetcher here
 * ignores that signal and passes `fetch` one of its own, aborted only when the page goes away (unmount: the
 * person left, or switched entity). The library is left as it is.
 */
import { useEffect, useRef, useState } from 'react'
import { LatestResultBusyError, useLatestResult } from '@operai/ui'
import type { LatestResult, PagePreviewState, PreviewPage } from '@operai/ui'
import { ApiError, sendJson } from '../lib/api'
import type { FormConfig, Problem } from '../lib/formStateTypes'
import type { Entity, IssuerDetails } from '../lib/types'

export type PreviewLanguage = 'it' | 'en'

/** What the preview is made from. Compared by value, so a fresh object each render is fine. */
export interface PreviewInput {
  entity: Entity
  config: FormConfig
  language: PreviewLanguage
  /** The layout of a stored version (G6); left out, the service uses its current layout. */
  layoutVersion?: number
}

/**
 * What the pane needs of the answer: the pages, in the language they were made in, and whether the issuer's details
 * were the registry's (`current`) or could not be read (`unavailable`, every issuer placeholder shown as missing).
 */
export interface PreviewResult {
  language: PreviewLanguage
  pages: readonly PreviewPage[]
  issuerDetails: IssuerDetails
  /** The registry version the details were read at; `null` when they could not be read. */
  legalEntityVersion: number | null
}

/** A 422 `invalid_letterhead`: the form holds refused values. Not a failure of the service (design F3.4). */
export class PreviewRefusedError extends Error {
  readonly problems: readonly Problem[]
  constructor(problems: readonly Problem[]) {
    super('The preview was refused')
    this.name = 'PreviewRefusedError'
    this.problems = problems
  }
}

/** The service's answer was not the shape of the contract. */
class PreviewShapeError extends Error {
  constructor() {
    super('The preview answer is not what the contract says')
    this.name = 'PreviewShapeError'
  }
}

/** `Retry-After` of a `busy` that names none: the service's own value. */
const DEFAULT_RETRY_MS = 2000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toProblems = (value: unknown): Problem[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Problem[] => {
        if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.reason !== 'string') return []
        return [
          {
            path: entry.path,
            reason: entry.reason,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(typeof entry.language === 'string' ? { language: entry.language } : {}),
          },
        ]
      })
    : []

function toPages(answer: unknown): PreviewPage[] {
  if (!isRecord(answer) || !Array.isArray(answer.pages)) throw new PreviewShapeError()
  return answer.pages.map((page: unknown) => {
    if (!isRecord(page) || typeof page.image !== 'string' || typeof page.text !== 'string')
      throw new PreviewShapeError()
    return { image: page.image, text: page.text }
  })
}

/** Only `"unavailable"` is a state of its own; a service that says nothing of it is read as `current`. */
const toIssuerDetails = (answer: Record<string, unknown>): IssuerDetails =>
  answer.issuerDetails === 'unavailable' ? 'unavailable' : 'current'

const toLegalEntityVersion = (answer: Record<string, unknown>): number | null =>
  typeof answer.legalEntityVersion === 'number' ? answer.legalEntityVersion : null

/**
 * One preview request. 422 `invalid_letterhead` becomes a `PreviewRefusedError`; 429 `busy` a
 * `LatestResultBusyError` that waits the service's `Retry-After`; everything else (5xx, 504, network, another
 * 4xx) stays what it is, a failure.
 */
export async function requestPreview(input: PreviewInput, signal?: AbortSignal): Promise<PreviewResult> {
  const body = {
    config: input.config,
    language: input.language,
    ...(input.layoutVersion === undefined ? {} : { layoutVersion: input.layoutVersion }),
  }
  try {
    const answer = await sendJson<unknown>(`/v1/letterheads/${input.entity}/preview`, 'POST', body, { signal })
    const pages = toPages(answer)
    const details = answer as Record<string, unknown>
    return {
      language: input.language,
      pages,
      issuerDetails: toIssuerDetails(details),
      legalEntityVersion: toLegalEntityVersion(details),
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 422 && error.code === 'invalid_letterhead') {
        throw new PreviewRefusedError(toProblems(error.extras.problems))
      }
      if (error.status === 429 && error.code === 'busy') {
        throw new LatestResultBusyError(
          error.retryAfterSeconds === null ? DEFAULT_RETRY_MS : error.retryAfterSeconds * 1000,
        )
      }
    }
    throw error
  }
}

/** The request's state, and the refusal that was the last answer (kept while the next request runs). */
export type PreviewRequest = LatestResult<PreviewResult> & {
  lastRefusal: PreviewRefusedError | null
  /** The entity the request is for (the pane's source line links to its Legal entities tab). */
  entity: Entity
}

/**
 * The live preview of `input`: one request 300 ms after the last edit (the first one at once), the previous
 * pages kept while the next are made or when they fail, `busy` retried once after `Retry-After`, an answer that
 * is no longer the newest discarded. In-flight requests are never aborted by an edit, only by unmount.
 *
 * `lastRefusal` is the refusal the last answer was, until a newer answer replaces it: the "last valid form"
 * notice must not blink off and on with every keystroke while the form is still refused.
 */
export function usePreviewRequest(input: PreviewInput): PreviewRequest {
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  // The hook's own signal (aborted on each edit) is deliberately not passed on.
  const ask = (current: PreviewInput) => requestPreview(current, lifetime.current?.signal)
  const latest = useLatestResult(input, ask, { debounceMs: 300, maxBusyRetries: 1 })

  const [lastRefusal, setLastRefusal] = useState<PreviewRefusedError | null>(null)
  const refusal = latest.status === 'failed' && latest.error instanceof PreviewRefusedError ? latest.error : null
  // Derived while rendering (no effect): replaced by each settled answer, kept while one is awaited.
  if ((latest.status === 'ready' || latest.status === 'failed') && refusal !== lastRefusal) setLastRefusal(refusal)
  return { ...latest, lastRefusal, entity: input.entity }
}

/** What the pane shows, derived from the request (see `describePreview`). */
export interface PreviewView {
  state: PagePreviewState
  pages: readonly PreviewPage[]
  /** The language the pages shown were made in (the screen reader's voice), if there are pages. */
  lang?: PreviewLanguage
  /** The form holds refused values: how many (info notice). */
  refused: number | null
  /** The preview could not be made (warning notice). */
  failed: boolean
  /** The registry's details could not be read: the pages show every issuer detail as missing (warning notice). */
  issuerUnavailable: boolean
  /** The entity the preview is of. */
  entity: Entity
}

interface RequestSnapshot {
  status: 'idle' | 'pending' | 'ready' | 'failed'
  result: PreviewResult | undefined
  error: unknown
  lastRefusal: PreviewRefusedError | null
  entity: Entity
}

/** Maps the request's status to the pane's state, notice and pages (design F3.2–F3.5, S7 states). */
export function describePreview({ status, result, error, lastRefusal, entity }: RequestSnapshot): PreviewView {
  const pages = result?.pages ?? []
  const refused = lastRefusal === null ? null : lastRefusal.problems.length
  const failed = status === 'failed' && !(error instanceof PreviewRefusedError)
  const state: PagePreviewState = failed
    ? 'failed'
    : status === 'pending' || status === 'idle'
      ? pages.length === 0
        ? 'loading'
        : 'updating'
      : 'ready'
  return {
    state,
    pages,
    lang: result?.language,
    refused,
    failed,
    issuerUnavailable: result?.issuerDetails === 'unavailable',
    entity,
  }
}

/**
 * A URL-dispatching stand-in for `shell/session`'s `apiFetch` (tests only): each route is
 * `METHOD /path` → a handler answering `{status, body}`. The request reaches the real
 * `lib/letterheadsApi.ts` + `lib/api.ts`, so a page test also exercises the request paths and headers
 * the contract fixes. Modelled on projects-ui/src/test-support/fakeApi.ts.
 */
import { vi } from 'vitest'
import type { Catalog, LetterheadList } from '../lib/types'

export type FakeAnswer = { status: number; body?: unknown }
export type FakeHandler = (url: URL, init: RequestInit | undefined) => FakeAnswer | Promise<FakeAnswer>

export function fakeApi(routes: Record<string, FakeHandler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    const handler = routes[key]
    if (!handler) return new Response(JSON.stringify({ status: 404, title: 'Not Found' }), { status: 404 })
    const answer = await handler(url, init)
    return answer.body === undefined
      ? new Response(null, { status: answer.status })
      : new Response(JSON.stringify(answer.body), { status: answer.status })
  })
}

/** A `Problem` answer: the shape every non-2xx of letterhead-api has. */
export const problem = (status: number, code?: string, extras: Record<string, unknown> = {}, detail = 'Problem') => ({
  status,
  body: { type: 'about:blank', title: 'Problem', status, detail, ...(code ? { code } : {}), ...extras },
})

/** A catalog with nothing in it: the frame only holds it. */
export const catalog = (): Catalog => ({ fonts: [], placeholders: [] })

/** Both entities, no letterhead saved yet and nothing the caller may change, unless a test says so. */
export const letterheadList = (overrides: Partial<LetterheadList> = {}): LetterheadList => ({
  welld_it: { activeVersion: null, canManage: false },
  welld_ch: { activeVersion: null, canManage: false },
  ...overrides,
})

/** A preview answer with `count` pages (`POST …/preview`), the registry's details read (`issuerDetails: "current"`); `tag` makes each page's picture and text distinct. */
export const previewAnswer = (count: number, tag = 'a') => ({
  letterheadVersion: null,
  issuerDetails: 'current' as const,
  legalEntityVersion: null as number | null,
  pageCount: count,
  missingPlaceholders: [],
  unprintableCharacters: [],
  pages: Array.from({ length: count }, (_, index) => ({
    n: index + 1,
    image: btoa(`png-${tag}-${index + 1}`),
    text: `Text ${tag} of page ${index + 1}`,
  })),
})

/**
 * A URL-dispatching stand-in for `shell/session`'s `apiFetch` (tests only): each route is `METHOD /path` → a handler
 * answering `{status, body}`. The request reaches the real `lib/*Api.ts` + `lib/api.ts`, so a page test also exercises
 * the request paths and headers the contract fixes. Modelled on letterheads-ui and projects-ui's `test-support/fakeApi.ts`.
 * An unrouted request answers 404 (like an unknown route of the service), so a test that forgot a route fails visibly.
 */
import { vi } from 'vitest'
import type { Me, MeEntity } from '../lib/meApi'

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

/** A `Problem` answer: the shape every non-2xx of accounting-api has (RFC 7807 with a stable `code`). */
export const problem = (status: number, code?: string, extras: Record<string, unknown> = {}, detail = 'Problem') => ({
  status,
  body: { type: 'about:blank', title: 'Problem', status, detail, ...(code ? { code } : {}), ...extras },
})

/** A `/v1/me` entity: WellD CH by default, a manager. */
export const meEntity = (overrides: Partial<MeEntity> = {}): MeEntity => ({
  entity: 'welld_ch',
  ownCurrency: 'CHF',
  canManage: true,
  rateSource: 'bazg',
  ...overrides,
})

/** WellD Italia as `/v1/me` lists it: EUR, no official rate source yet (D19). */
export const meItalia = (overrides: Partial<MeEntity> = {}): MeEntity =>
  meEntity({ entity: 'welld_it', ownCurrency: 'EUR', rateSource: null, ...overrides })

/** A `/v1/me` answer. */
export const meAnswer = (...entities: MeEntity[]): FakeAnswer => ({
  status: 200,
  body: { entities } satisfies Me,
})

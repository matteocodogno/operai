/**
 * Test support for every hours-ui test that talks to a service (specs/029-time-tracking T22).
 *
 * `fakeApi` is a URL-dispatching stand-in for `shell/session`'s `apiFetch`: each route is
 * `METHOD /path` (a `:name` segment matches any one path segment and arrives in `params`) → a
 * handler answering `{status, body}`. The request reaches the real `lib/hoursApi.ts`, so a page test
 * also exercises the paths, query strings and bodies the contract fixes.
 *
 * It covers every route the plan has, so no later task edits this file to add one (tasks.md § Shared
 * files): hours-api's ten routes (§ API contracts: entries, totals, lists, and the category and work-type
 * writes admin-ui makes) and the four owner searches hours-ui makes as the person (§ Components `hours-ui`:
 * projects-api `GET /projects?q=`, crm-api `GET /deals?q=`, meetings-api `GET /meetings?q=` and
 * activities-api `GET /activities?projectId=|dealId=`). Every route has a default answer of the right shape
 * (an empty page, nothing counted, the seeded lists, an echo of what was written); a test overrides exactly
 * the routes it is about: `fakeApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([…]) }) })`.
 *
 * A route answers only on its own service's origin (`ORIGINS`, see `fakeSession.ts`), so a request sent to the
 * wrong service reaches nothing: the deal picker asking hours-api is a bug a test should see. An unrouted
 * request is a 404 Problem whose `detail` names it, which is also what the real servers answer for "does not
 * exist" and "not visible to you" (AC-2.10). Like a real fetch, a request whose `signal` aborts rejects with an
 * `AbortError`, so a test of "stale answers are discarded" behaves as in the browser.
 *
 * The fixtures are typed with the wire types of `lib/hoursApi.types.ts`, so a contract change that is not
 * followed here fails the build, not a test at random. Defaults describe the commonest state; a test overrides
 * exactly the members it is about. The owners' shapes are what those services answer, the members the pickers
 * read included; this module does not own them.
 */
import { vi } from 'vitest'
import type {
  CategoryView,
  EntriesPage,
  EntryInput,
  EntryOn,
  EntryOnInput,
  MeetingDeal,
  Person,
  TimeEntryView,
  TimeListsView,
  TotalsAnswer,
  TotalsGroup,
  Unavailable,
  Visibility,
  WorkTypeView,
} from '../lib/hoursApi.types'
import { ORIGINS, type FakeService } from './fakeSession'

export type FakeAnswer = { status: number; body?: unknown; headers?: Record<string, string> }
export type FakeParams = Record<string, string>
export type FakeHandler = (
  url: URL,
  init: RequestInit | undefined,
  params: FakeParams,
) => FakeAnswer | Promise<FakeAnswer>

/** A Problem JSON body (RFC 7807) with the top-level `code` and any extension members. */
export const problem = (status: number, code?: string, extras: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title: `Problem ${status}`,
  status,
  ...(code !== undefined ? { code } : {}),
  ...extras,
})

// ─── People ─────────────────────────────────────────────────────────────────

export const ADA: Person = { id: 'u-ada', name: 'Ada Lovelace', status: 'active' }
export const GRACE: Person = { id: 'u-grace', name: 'Grace Hopper', status: 'active' }
/** A deactivated account: its name is no longer resolved. */
export const GONE: Person = { id: 'u-gone', name: null, status: 'deleted' }

// ─── Entries ────────────────────────────────────────────────────────────────

const named =
  (type: 'project' | 'deal', pathOf: (id: string) => string) =>
  (id: string, label: string | null = `${type} ${id}`, visibility: Visibility = 'visible') => {
    const visible = visibility === 'visible'
    return {
      type,
      id,
      label: visible ? label : null,
      href: visible ? pathOf(id) : null,
      visibility,
    } as const
  }

/** `on` of a project entry; `hidden` / `unavailable` carry no name and no link (AC-4.10, AC-4.7). */
export const projectOn = named('project', (id) => `/projects/${id}`)

/** `on` of a deal entry. */
export const dealOn = named('deal', (id) => `/crm/deals/${id}`)

/** `on` of a meeting entry, with the deal its hours count for (AC-2.6): none unless a test says. */
export const meetingOn = (
  id: string,
  label: string | null = `meeting ${id}`,
  deal: MeetingDeal = { state: 'none' },
  visibility: Visibility = 'visible',
): Extract<EntryOn, { type: 'meeting' }> => {
  const visible = visibility === 'visible'
  return {
    type: 'meeting',
    id,
    label: visible ? label : null,
    href: visible ? `/my-meetings/m/${id}` : null,
    visibility,
    deal,
  }
}

/** `on` of an entry that is on no entity: its category. */
export const otherWorkOn = (
  name: string,
  id = `tc-${name.toLowerCase().replace(/\W+/g, '-')}`,
  retired = false,
): EntryOn => ({
  type: 'none',
  category: { id, name, retired },
})

/** A project entry of 2 h by Ada on 12 November 2026; a test overrides what it is about. */
export const timeEntryView = (overrides: Partial<TimeEntryView> = {}): TimeEntryView => ({
  id: 'e1',
  day: '2026-11-12',
  minutes: 120,
  note: null,
  person: ADA,
  on: projectOn('p1', 'Project Alpha'),
  workType: null,
  activity: null,
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
  ...overrides,
})

/**
 * The entry as hours-api answers it to anyone but its author (D44; plan § Views "Ids of what the viewer cannot
 * read"): `on.id` (project, deal, meeting) and `activity.id` are `null` unless that record is `visible`; a
 * record the viewer can read keeps its id, and so does everything else. The builders above describe the record
 * as stored, so a fixture of another person's entry (Everyone's hours, the export) goes through here.
 */
export const seenByOthers = (entry: TimeEntryView): TimeEntryView => ({
  ...entry,
  on: entry.on.type !== 'none' && entry.on.visibility !== 'visible' ? { ...entry.on, id: null } : entry.on,
  activity:
    entry.activity !== null && entry.activity.visibility !== 'visible'
      ? { ...entry.activity, id: null }
      : entry.activity,
})

/**
 * The entry with no id on its project, deal, meeting or activity, whatever their visibility: what a server that
 * broke "the author keeps the ids" (D44) would send the author. For the tests of what the edit dialog does then.
 */
export const withoutIds = (entry: TimeEntryView): TimeEntryView => ({
  ...entry,
  on: entry.on.type === 'none' ? entry.on : { ...entry.on, id: null },
  activity: entry.activity === null ? null : { ...entry.activity, id: null },
})

/**
 * The entry with an id on every record, as hours-api sent them before D44: an id that is missing is made up
 * (`withheld-…`), one that is there stays. For the tests that a screen reads no id: it must draw the same either way.
 */
export const withIds = (entry: TimeEntryView): TimeEntryView => ({
  ...entry,
  on: entry.on.type === 'none' ? entry.on : { ...entry.on, id: entry.on.id ?? `withheld-${entry.on.type}-${entry.id}` },
  activity:
    entry.activity === null ? null : { ...entry.activity, id: entry.activity.id ?? `withheld-activity-${entry.id}` },
})

export const entriesPage = (
  items: TimeEntryView[],
  { nextCursor = null, unavailable = [] }: { nextCursor?: string | null; unavailable?: Unavailable } = {},
): EntriesPage => ({ items, nextCursor, unavailable })

/** Totals whose groups add up to `totalMinutes`, as the server guarantees (plan § Totals). */
export const totalsAnswer = (groups: TotalsGroup[], unavailable: Unavailable = []): TotalsAnswer => ({
  totalMinutes: groups.reduce((sum, group) => sum + group.minutes, 0),
  groups,
  unavailable,
})

// ─── Lists ──────────────────────────────────────────────────────────────────

const category = (id: string, name: string, requiresNote = false): CategoryView => ({
  id,
  name,
  requiresNote,
  retired: false,
})
const workType = (list: 'project' | 'deal', id: string, name: string): WorkTypeView => ({
  id,
  list,
  name,
  retired: false,
})

/** The rows a fresh database holds (plan § Data model, A15). */
export const SEED_LISTS: TimeListsView = {
  categories: [
    category('tc-training', 'Training'),
    category('tc-talk-preparation', 'Talk preparation'),
    category('tc-administration', 'Administration'),
    category('tc-other', 'Other', true),
  ],
  workTypes: {
    project: [
      workType('project', 'wt-project-development', 'Development'),
      workType('project', 'wt-project-analysis', 'Analysis'),
      workType('project', 'wt-project-management', 'Management'),
      workType('project', 'wt-project-support', 'Support'),
    ],
    deal: [
      workType('deal', 'wt-deal-analysis', 'Analysis'),
      workType('deal', 'wt-deal-estimate', 'Estimate'),
      workType('deal', 'wt-deal-demo', 'Demo'),
      workType('deal', 'wt-deal-offer', 'Offer'),
    ],
  },
}

/** `GET /time-lists` over `lists`: retired items only with `includeRetired=true`, as the server does (plan § Lists). */
export const listsHandler =
  (lists: TimeListsView): FakeHandler =>
  (url) => {
    const includeRetired = url.searchParams.get('includeRetired') === 'true'
    const keep = <T extends { retired: boolean }>(items: T[]) => items.filter((item) => includeRetired || !item.retired)
    return {
      status: 200,
      body: {
        categories: keep(lists.categories),
        workTypes: { project: keep(lists.workTypes.project), deal: keep(lists.workTypes.deal) },
      } satisfies TimeListsView,
    }
  }

// ─── The owners (what the pickers search, as the person) ────────────────────

/** The envelope of the owners' lists (projects-api, crm-api, meetings-api, activities-api). */
export const page = <T>(items: T[], total = items.length, pageNumber = 1) => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25,
})

/** A row of projects-api `GET /projects`. */
export const projectItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Project Alpha',
  type: 'internal',
  state: 'active',
  entity: 'welld_ch',
  company: null,
  projectManager: { id: ADA.id, name: ADA.name, deleted: false },
  awaitingProjectManager: false,
  ...overrides,
})

/** A row of crm-api `GET /deals`. */
export const dealItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  title: 'Acme renewal',
  company: { id: 'c1', name: 'Acme' },
  stage: 'proposal',
  entity: 'welld_ch',
  expectedCloseDate: null,
  owner: ADA,
  closedAt: null,
  updatedAt: '2026-11-10T09:00:00.000Z',
  version: 1,
  estimateState: null,
  estimateOverridden: false,
  ...overrides,
})

/** A row of meetings-api `GET /meetings`: the caller's own, as creator or participant. */
export const meetingRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  title: 'Kick-off with Acme',
  startsAt: '2026-11-03T09:30:00.000Z',
  format: 'online',
  status: 'ready',
  host: null,
  role: 'creator',
  summaryCount: 0,
  creator: ADA,
  ...overrides,
})

/** An item of activities-api `GET /activities` (a project's are tasks). */
export const activityItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  kind: 'operational',
  type: 'task',
  subject: 'Write the offer',
  body: null,
  occurredAt: '2026-11-05T09:00:00.000Z',
  company: null,
  project: { id: 'p1', name: 'Project Alpha' },
  contact: null,
  deal: null,
  author: ADA,
  participants: [],
  meeting: null,
  task: null,
  may: { edit: false, delete: false, complete: false },
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
  ...overrides,
})

// ─── Default answers ────────────────────────────────────────────────────────

/** The JSON body of a write, read as the members the route takes (`{}` for none). */
const bodyOf = <T extends object>(init: RequestInit | undefined): Partial<T> =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as Partial<T>) : {}

const categoryNamed = (id: string) => SEED_LISTS.categories.find((c) => c.id === id)
const workTypeNamed = (id: string) =>
  [...SEED_LISTS.workTypes.project, ...SEED_LISTS.workTypes.deal].find((w) => w.id === id)

const onOf = (on: EntryOnInput): EntryOn => {
  switch (on.type) {
    case 'project':
      return projectOn(on.id, `Project ${on.id}`)
    case 'deal':
      return dealOn(on.id, `Deal ${on.id}`)
    case 'meeting':
      return meetingOn(on.id, `Meeting ${on.id}`)
    case 'none':
      return otherWorkOn(categoryNamed(on.categoryId)?.name ?? on.categoryId, on.categoryId)
  }
}

/** The view of `base` after a create or a change, member by member: absent keeps, `null` clears. */
const applied = (base: TimeEntryView, input: Partial<EntryInput>): TimeEntryView => ({
  ...base,
  ...(input.day !== undefined ? { day: input.day } : {}),
  ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
  ...(input.note !== undefined ? { note: input.note } : {}),
  ...(input.on !== undefined ? { on: onOf(input.on) } : {}),
  ...(input.workTypeId !== undefined
    ? {
        workType:
          input.workTypeId === null
            ? null
            : {
                id: input.workTypeId,
                name: workTypeNamed(input.workTypeId)?.name ?? input.workTypeId,
                retired: false,
              },
      }
    : {}),
  ...(input.activityId !== undefined
    ? {
        activity:
          input.activityId === null
            ? null
            : { id: input.activityId, subject: `Activity ${input.activityId}`, visibility: 'visible' as const },
      }
    : {}),
})

let created = 0

type Route = { service: FakeService; handler: FakeHandler }

const ROUTES = {
  // hours-api, entries and totals (plan § Entries, § Totals)
  'GET /time-entries': { service: 'hours', handler: () => ({ status: 200, body: entriesPage([]) }) },
  'POST /time-entries': {
    service: 'hours',
    handler: (_url, init) => ({
      status: 201,
      body: applied(timeEntryView({ id: `e-new-${++created}`, on: projectOn('p1') }), bodyOf<EntryInput>(init)),
    }),
  },
  'PATCH /time-entries/:id': {
    service: 'hours',
    handler: (_url, init, params) => ({
      status: 200,
      body: applied(timeEntryView({ id: params['id'] }), bodyOf<EntryInput>(init)),
    }),
  },
  'DELETE /time-entries/:id': { service: 'hours', handler: () => ({ status: 204 }) },
  'GET /time-entries/totals': { service: 'hours', handler: () => ({ status: 200, body: totalsAnswer([]) }) },
  // hours-api, lists (plan § Lists): the reads, and the writes admin-ui makes
  'GET /time-lists': { service: 'hours', handler: listsHandler(SEED_LISTS) },
  'POST /time-categories': {
    service: 'hours',
    handler: (_url, init) => {
      const { name = '', requiresNote = false } = bodyOf<CategoryView>(init)
      return {
        status: 201,
        body: { id: `tc-new-${++created}`, name, requiresNote, retired: false } satisfies CategoryView,
      }
    },
  },
  'PATCH /time-categories/:id': {
    service: 'hours',
    handler: (_url, init, params) => ({
      status: 200,
      body: {
        ...(categoryNamed(params['id']) ?? category(params['id'], params['id'])),
        ...bodyOf<CategoryView>(init),
      } satisfies CategoryView,
    }),
  },
  'POST /work-types': {
    service: 'hours',
    handler: (_url, init) => {
      const { list = 'project', name = '' } = bodyOf<WorkTypeView>(init)
      return { status: 201, body: { id: `wt-new-${++created}`, list, name, retired: false } satisfies WorkTypeView }
    },
  },
  'PATCH /work-types/:id': {
    service: 'hours',
    handler: (_url, init, params) => ({
      status: 200,
      body: {
        ...(workTypeNamed(params['id']) ?? workType('project', params['id'], params['id'])),
        ...bodyOf<WorkTypeView>(init),
      } satisfies WorkTypeView,
    }),
  },
  // The owners, read as the person (plan § Components `hours-ui`)
  'GET /projects': { service: 'projects', handler: () => ({ status: 200, body: page([]) }) },
  'GET /deals': { service: 'crm', handler: () => ({ status: 200, body: page([]) }) },
  'GET /meetings': { service: 'meetings', handler: () => ({ status: 200, body: page([]) }) },
  'GET /activities': { service: 'activities', handler: () => ({ status: 200, body: page([]) }) },
} satisfies Record<string, Route>

/** Every route `fakeApi` knows, as `METHOD /path`. */
export type FakeRoute = keyof typeof ROUTES

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

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

/** Settles with `work`, or rejects as a real fetch does the moment `signal` aborts. */
const unlessAborted = <T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> => {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function fakeApi(overrides: Partial<Record<FakeRoute, FakeHandler>> = {}) {
  // Exact routes first, so `GET /time-entries/totals` is never read as a parameterised path.
  const compiled = (Object.entries(ROUTES) as [FakeRoute, Route][])
    .map(([pattern, route]) => ({
      ...compile(pattern),
      origin: ORIGINS[route.service],
      handler: overrides[pattern] ?? route.handler,
    }))
    .sort((a, b) => Number(b.exact) - Number(a.exact))

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const answer = async (): Promise<Response> => {
      for (const route of compiled) {
        if (route.method !== method || route.origin !== url.origin) continue
        const match = route.regex.exec(url.pathname)
        if (!match) continue
        const params = Object.fromEntries(
          route.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
        )
        const result = await route.handler(url, init, params)
        return result.body === undefined
          ? new Response(null, { status: result.status, headers: result.headers })
          : new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers })
      }
      return new Response(
        JSON.stringify(
          problem(404, 'not_found', { detail: `No fake route for ${method} ${url.origin}${url.pathname}` }),
        ),
        { status: 404 },
      )
    }
    return unlessAborted(answer(), init?.signal)
  })
}

// ─── Reading what was asked ─────────────────────────────────────────────────

export type FakeRequest = {
  method: string
  origin: string
  path: string
  /** The query as a plain object (a repeated name keeps its last value). */
  query: Record<string, string>
  /** The JSON body of a write, else `undefined`. */
  body: unknown
}

/** What `api` received, in order, parsed; for one route when `route` is given. */
export function requests(api: ReturnType<typeof fakeApi>, route?: FakeRoute): FakeRequest[] {
  const wanted = route ? compile(route) : null
  const out: FakeRequest[] = []
  for (const [input, init] of api.mock.calls) {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (wanted) {
      const origin = ORIGINS[ROUTES[route!].service]
      if (method !== wanted.method || url.origin !== origin || !wanted.regex.test(url.pathname)) continue
    }
    out.push({
      method,
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    })
  }
  return out
}

// ─── Timing ─────────────────────────────────────────────────────────────────

/** Answers with each handler in turn, then keeps repeating the last: "fails once, then works". */
export const sequence = (...handlers: FakeHandler[]): FakeHandler => {
  let calls = 0
  return (url, init, params) => handlers[Math.min(calls++, handlers.length - 1)]!(url, init, params)
}

/** A promise settled from outside, to hold an answer back and release it when the test says. */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Test-only fixture bridge for specs/20261112-time-tracking e2e (T35, T36).
 *
 * Time tracking is ungated (ADR 20261112-hours-ui-ungated-remote): a person's own hours need no tool grant, so
 * the people a journey needs differ only in the roles they hold:
 *
 *   employee    `employee` only: no tool grant at all (AC-5.1); records and reads their own hours
 *   admin       the real `admin` role (one per run): `time-entry:read-all` (Everyone's hours) and `time-list:manage` (Settings)
 *
 * Roles are changed through the REAL admin API (`PUT /admin/users/:id/roles`, which bumps `perm_epoch`), exactly
 * as meetingsFixtures and activitiesFixtures do, so hours-api's live `GET /authz/resolve` sees these people like
 * any admin-granted user. Only dedicated `hrs-*` personas ever get their roles rewritten: the shared seed user and
 * any real person are refused.
 *
 * SETUP and out-of-band VERIFICATION go through the real REST APIs with a real, seeded Bearer token; nothing here
 * writes a row behind an API's back. Everything a journey asserts about what a person SEES or DOES is driven
 * through the browser. What a journey records it removes again in `afterAll` (a person deletes their OWN entries;
 * nobody deletes someone else's, and no list item is ever deleted: a category a journey made is retired).
 */
import type { BrowserContext, Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, type SeededSession } from './adminSession'
import { cleanupPeople, newRunId, signInContext, SHARED_SEED_EMAIL } from './meetingsFixtures'

export { cleanupPeople, newRunId, signInContext }

const trim = (url: string): string => url.replace(/\/$/, '')

export const AUTH_URL = trim(process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001')
export const HOURS_API_URL = trim(
  process.env['E2E_HOURS_API_URL'] ?? process.env['VITE_HOURS_API_URL'] ?? 'http://localhost:8090',
)

type Json = Record<string, unknown>

// ─── Dates and durations ────────────────────────────────────────────────────

/**
 * Today as hours-api and hours-ui read it: the calendar day in Europe/Zurich (`future_day` is judged against it,
 * and it is the entry dialog's default Day). `en-CA` writes `YYYY-MM-DD`.
 */
export const todayZurich = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

/** The first and last day of the calendar month `day` (a `YYYY-MM-DD`) is in. */
export const monthOf = (day: string): { from: string; to: string } => {
  const [year, month] = day.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` }
}

/**
 * The minutes a screen's short duration stands for: "3 h 30", "2 h" and "30 min" (operai-ui `formatDuration`,
 * `short` style, English). Anything else throws: a figure this helper cannot read must fail the journey, not pass
 * as 0.
 */
export const minutesOfShort = (text: string): number => {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  const hours = /^(\d+) h(?: (\d+))?$/.exec(cleaned)
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0)
  const minutes = /^(\d+) min$/.exec(cleaned)
  if (minutes) return Number(minutes[1])
  throw new Error(`[hoursFixtures] not a short duration: "${text}"`)
}

// ─── People ─────────────────────────────────────────────────────────────────

const admins = new Map<string, SeededSession>()

/**
 * An admin for THIS run (`hrs-admin-<runId>@operai.test`, removed by cleanupPeople with the other people of the run).
 * Per run, not a fixed account: hours-api reads a person's name from auth live, and auth rate-limits that lookup per
 * caller (120 per 10 minutes), so one account shared by every run exhausts the budget when specs are re-run in a
 * dev loop and Everyone's hours then, correctly, shows names as unavailable. One session per run and process.
 */
export async function hoursAdmin(runId: string): Promise<SeededSession> {
  let admin = admins.get(runId)
  if (!admin) {
    admin = await seedAdminSession(`hrs-admin-${runId}@operai.test`, `Hours QE Admin ${runId}`)
    admins.set(runId, admin)
  }
  return admin
}

async function authAdminCall<T = Json>(
  admin: SeededSession,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${AUTH_URL}${route}`, {
    method,
    headers: {
      // auth's own /admin/* routes are cookie-session guarded (the Bearer form 401s)
      Cookie: admin.cookieHeader,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`[hoursFixtures] ${method} ${route} -> ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

/**
 * Replaces a user's direct roles by role NAME, through the real admin API. Only ever called for the dedicated
 * `hrs-*` personas this harness creates itself: anything else is refused.
 */
async function setRoles(userId: string, roleNames: string[], email: string, runId: string): Promise<void> {
  if (!/^hrs-[a-z-]+-[0-9-]+@operai\.test$/.test(email) || email === SHARED_SEED_EMAIL) {
    throw new Error(`[hoursFixtures] refusing to change roles of ${email}: not a dedicated hours persona`)
  }
  const admin = await hoursAdmin(runId)
  const roles = await authAdminCall<{ items?: { id: string; name: string }[] } | { id: string; name: string }[]>(
    admin,
    'GET',
    '/admin/roles',
  )
  const list = Array.isArray(roles) ? roles : (roles.items ?? [])
  const roleIds = roleNames.map((name) => {
    const role = list.find((r) => r.name === name)
    if (!role) throw new Error(`[hoursFixtures] role "${name}" does not exist (has the auth seed run?)`)
    return role.id
  })
  await authAdminCall(admin, 'PUT', `/admin/users/${userId}/roles`, { roleIds })
}

export interface HoursPerson extends SeededSession {
  name: string
  roles: string[]
}

/**
 * Creates the role `name` when it does not exist, then full-replaces its rules (idempotent), through the real admin
 * API (`POST /admin/roles`, `PUT /admin/roles/{id}/rules`), exactly as an administrator would. Used for the one thing
 * the real `admin` role cannot show: a role that holds a single hours permission and nothing else (AC-3.3 / D51: the
 * permission alone reaches Settings; AC-4.2: read-all alone reaches Everyone's hours). Returns the role id.
 */
export async function ensureRole(
  admin: SeededSession,
  name: string,
  rules: Array<{ resource: string; action: string }>,
): Promise<string> {
  const listed = await authAdminCall<{ id: string; name: string }[] | { items?: { id: string; name: string }[] }>(
    admin,
    'GET',
    '/admin/roles',
  )
  const existing = (Array.isArray(listed) ? listed : (listed.items ?? [])).find((role) => role.name === name)
  const id =
    existing?.id ??
    (
      await authAdminCall<{ id: string }>(admin, 'POST', '/admin/roles', {
        name,
        description: 'hours e2e: one permission only',
      })
    ).id
  await authAdminCall(admin, 'PUT', `/admin/roles/${id}/rules`, { rules })
  return id
}

/** Best-effort removal of a role a journey made: its holders lose it first, then it is deleted. */
export async function deleteRoleQuietly(admin: SeededSession, roleId: string, holders: SeededSession[]): Promise<void> {
  for (const holder of holders) {
    try {
      await authAdminCall(admin, 'PUT', `/admin/users/${holder.userId}/roles`, { roleIds: [] })
    } catch {
      // cleanup must never fail a run
    }
  }
  try {
    await authAdminCall(admin, 'DELETE', `/admin/roles/${roleId}`)
  } catch {
    // cleanup must never fail a run; a leftover role holds one hours permission and no person
  }
}

/**
 * Seeds a session for a new `@operai.test` user left with exactly `roles` (a per-run e-mail, see newRunId: user
 * rows persist in the shared dev DB, so a journey never reuses one). The token is minted AFTER the role change.
 */
export async function seedHoursPerson(label: string, roles: string[], runId: string): Promise<HoursPerson> {
  const name = `Hrs ${label} ${runId}`
  const email = `hrs-${label}-${runId}@operai.test`
  const first = await seedUserSession(email, name)
  await setRoles(first.userId, roles, email, runId)
  const session = await seedUserSession(email, name)
  return { ...session, name, roles }
}

/** A fresh signed-in browser context for `session`. */
export async function personContext(
  browser: { newContext: () => Promise<BrowserContext> },
  session: SeededSession,
): Promise<BrowserContext> {
  const context = await browser.newContext()
  await signInContext(context, session)
  return context
}

// ─── hours-api ──────────────────────────────────────────────────────────────

export interface ApiResult<T = Json> {
  status: number
  body: T
}

/** A JSON call to hours-api as `session`. Never throws on a status: the caller asserts what it expects. */
export async function hoursCall<T = Json>(
  session: SeededSession,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${HOURS_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed as T }
}

/** A setup call that must succeed: any non-2xx stops the run with the Problem body in the message. */
export async function mustHoursCall<T = Json>(
  session: SeededSession,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string,
  body?: unknown,
): Promise<T> {
  const result = await hoursCall<T>(session, method, route, body)
  if (result.status < 200 || result.status >= 300) {
    const hint =
      result.status === 401 || result.status === 503
        ? ' (is hours-api up with its own .env? `curl -s localhost:8090/health`)'
        : ''
    throw new Error(
      `[hoursFixtures] ${method} ${HOURS_API_URL}${route} -> ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}${hint}`,
    )
  }
  return result.body
}

export interface EntryRow {
  id: string
  day: string
  minutes: number
  note: string | null
  person: { id: string; name: string | null; status: string }
  on: { type: string; id?: string | null; label?: string | null; category?: { id: string; name: string } }
}

export interface CategoryRow {
  id: string
  name: string
  requiresNote: boolean
  retired: boolean
}

export interface TimeLists {
  categories: CategoryRow[]
  workTypes: { project: unknown[]; deal: unknown[] }
}

/** The lists as the entry dialog reads them, retired items included. */
export const timeListsViaApi = (session: SeededSession): Promise<TimeLists> =>
  mustHoursCall<TimeLists>(session, 'GET', '/time-lists?includeRetired=true')

/**
 * Two active categories that need no note, preferring the seeded `Training` and `Administration`: the
 * journeys record "Other work" on them. Read from the lists, never assumed, so a list an admin has edited
 * still gives a usable pair; the run stops with a clear message when there are fewer than two.
 */
export async function pickCategories(session: SeededSession): Promise<[CategoryRow, CategoryRow]> {
  const lists = await timeListsViaApi(session)
  const usable = lists.categories.filter((category) => !category.retired && !category.requiresNote)
  const preferred = ['tc-training', 'tc-administration']
    .map((id) => usable.find((category) => category.id === id))
    .filter((category): category is CategoryRow => category !== undefined)
  const rest = usable.filter((category) => !preferred.includes(category))
  const pair = [...preferred, ...rest].slice(0, 2)
  if (pair.length < 2) {
    throw new Error(`[hoursFixtures] need two active categories without a required note, found ${usable.length}`)
  }
  return [pair[0]!, pair[1]!]
}

/** The caller's own entries of a day span, every page (setup and verification: the journeys read the screen). */
export async function ownEntriesViaApi(session: SeededSession, from: string, to: string): Promise<EntryRow[]> {
  const items: EntryRow[] = []
  let cursor: string | null = null
  do {
    const query: string = `/time-entries?whose=mine&from=${from}&to=${to}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page: { items: EntryRow[]; nextCursor: string | null } = await mustHoursCall(session, 'GET', query)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

/** Records an entry through the API as `session` (setup only; the journeys that test recording use the dialog). */
export const createEntryViaApi = (session: SeededSession, input: unknown): Promise<EntryRow> =>
  mustHoursCall<EntryRow>(session, 'POST', '/time-entries', input)

/** Best-effort removal of everything `session` recorded since `from` (a person deletes their own entries only). */
export async function deleteOwnEntriesQuietly(session: SeededSession, from: string): Promise<void> {
  try {
    const entries = await ownEntriesViaApi(session, from, todayZurich())
    for (const entry of entries) await hoursCall(session, 'DELETE', `/time-entries/${encodeURIComponent(entry.id)}`)
  } catch {
    // cleanup must never fail a run
  }
}

/** Best-effort retire of a category a journey made (no list item is ever deleted, AC-3.2). */
export async function retireCategoryQuietly(admin: SeededSession, id: string): Promise<void> {
  try {
    await hoursCall(admin, 'PATCH', `/time-categories/${encodeURIComponent(id)}`, { retired: true })
  } catch {
    // cleanup must never fail a run
  }
}

// ─── Browser helpers ────────────────────────────────────────────────────────

/** Opens the header user menu and follows "My hours", like a person would (never by address). */
export async function openMyHoursFromMenu(page: Page, displayName: string): Promise<void> {
  await page.getByRole('button', { name: displayName }).click()
  await page.getByRole('menuitem', { name: 'My hours' }).click()
}

/**
 * Records "Other work" through the entry dialog: the duration (minutes, a multiple of 30), the category by id
 * and, when given, a note; then waits for the confirmation. Leaves My hours with the dialog closed.
 */
export async function recordOtherWork(
  page: Page,
  input: { minutes: number; categoryId: string; note?: string },
): Promise<void> {
  await page.getByTestId('hours-record').click()
  const dialog = page.getByRole('dialog', { name: 'Record hours' })
  await dialog.waitFor()
  // The Duration is typed (T45, D53): decimal hours read as the person would write them, 90 minutes as 1.5.
  await dialog.getByTestId('hours-entry-duration').fill(String(input.minutes / 60))
  await dialog.getByTestId('hours-entry-on-none').check()
  await dialog.getByTestId('hours-entry-category').selectOption(input.categoryId)
  if (input.note !== undefined) await dialog.getByTestId('hours-entry-note').fill(input.note)
  await dialog.getByTestId('hours-entry-dialog-submit').click()
  await dialog.waitFor({ state: 'detached' })
}

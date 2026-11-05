/**
 * Test-only fixture bridge for specs/021-meetings e2e (T86).
 *
 * Meetings access is record-based (creator / participant / host reader, never a
 * role) plus ONE capability, `meetings:access`, which the baseline `employee`
 * role carries by default (AC-10.8). So the people a journey needs are:
 *
 *   holder        a signed-in user with the baseline role  (meetings:access)
 *   no-grant      a signed-in user whose roles were emptied (no meetings:access;
 *                 AC-10.5: they still reach My meetings and read what they were added to)
 *   crm-technical `crm:access` only (no meetings:access, no deal:manage)
 *   sales / admin the real seeded roles (admin = erase + template:manage + deal:manage)
 *
 * Roles are changed through the REAL admin API (`PUT /admin/users/:id/roles`,
 * which bumps `perm_epoch`) with a seeded admin session, so meetings-api's live
 * `GET /authz/resolve` resolves these users exactly like an admin-granted one.
 * Nothing here writes meetings or CRM rows behind the API's back.
 *
 * Everything a journey asserts about what a person SEES is asserted through the
 * browser; the REST helpers below are for SETUP and out-of-band verification.
 *
 * Fake AI and the host registry: meetings-api runs with `MEETINGS_AI_PROVIDER=fake`
 * (fake transcriber + fake LLM) and the production host registry (`crm/deal`
 * only). Browser capture uses Chromium's fake microphone, see the `meetings`
 * project in playwright.config.ts. `MEETINGS_TEST_HOSTS` is a meetings-api
 * process env: this harness neither sets nor needs it (the deal is the host),
 * and meetings-api is never stopped from here — "meetings-api down" is
 * simulated in the browser with `blockMeetingsApi`.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, type SeededSession } from './adminSession'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const trim = (url: string): string => url.replace(/\/$/, '')

export const AUTH_URL = trim(process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001')
export const MEETINGS_API_URL = trim(
  process.env['E2E_MEETINGS_API_URL'] ?? process.env['VITE_MEETINGS_API_URL'] ?? 'http://localhost:8085',
)
export const CRM_API_URL = trim(
  process.env['E2E_CRM_API_URL'] ?? process.env['VITE_CRM_API_URL'] ?? 'http://localhost:8084',
)

type Json = Record<string, unknown>

// ─── People ─────────────────────────────────────────────────────────────────

export type MeetingsPersona = 'holder' | 'no-grant' | 'crm-technical' | 'sales' | 'admin'

/** Role names each persona is left with (replaces the user's direct roles). */
const PERSONA_ROLES: Record<Exclude<MeetingsPersona, 'admin'>, string[]> = {
  holder: ['employee'],
  'no-grant': [],
  'crm-technical': ['crm-technical'],
  sales: ['employee', 'sales'],
}

/** A per-run suffix: user rows persist in the shared dev DB, so a journey never reuses an e-mail. */
export const newRunId = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

let sharedAdmin: SeededSession | null = null

/** One admin session per worker process (the admin role is real; see adminSession.ts). */
export async function meetingsAdmin(): Promise<SeededSession> {
  // a fixed e-mail: idempotent, and never removed by cleanupPeople (its pattern needs a run id)
  sharedAdmin ??= await seedAdminSession('mtg-qe-admin@operai.test', 'Meetings QE Admin')
  return sharedAdmin
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
  if (!res.ok) throw new Error(`[meetingsFixtures] ${method} ${route} -> ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** Replaces a user's direct roles by role NAME, through the real admin API. */
export async function setRoles(userId: string, roleNames: string[]): Promise<void> {
  const admin = await meetingsAdmin()
  const roles = await authAdminCall<{ items?: { id: string; name: string }[] } | { id: string; name: string }[]>(
    admin,
    'GET',
    '/admin/roles',
  )
  const list = Array.isArray(roles) ? roles : (roles.items ?? [])
  const roleIds = roleNames.map((name) => {
    const role = list.find((r) => r.name === name)
    if (!role) throw new Error(`[meetingsFixtures] role "${name}" does not exist (has the auth seed run?)`)
    return role.id
  })
  await authAdminCall(admin, 'PUT', `/admin/users/${userId}/roles`, { roleIds })
}

export interface Person extends SeededSession {
  name: string
  persona: MeetingsPersona
}

/**
 * Seeds a session for a new `@operai.test` user and leaves it with the persona's
 * roles. The token is minted AFTER the role change (it carries identity only,
 * ADR-0007, so this is belt and braces).
 */
export async function seedPerson(label: string, persona: MeetingsPersona, runId: string): Promise<Person> {
  const name = `Mtg ${label} ${runId}`
  const email = `mtg-${label}-${runId}@operai.test`
  if (persona === 'admin') {
    const admin = await seedAdminSession(email, name)
    return { ...admin, name, persona }
  }
  const first = await seedUserSession(email, name)
  await setRoles(first.userId, PERSONA_ROLES[persona])
  const session = await seedUserSession(email, name)
  return { ...session, name, persona }
}

/** Deletes the people a journey created (users, roles, sessions). Best effort. */
export async function cleanupPeople(runId: string): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync('direnv', ['exec', '.', 'bun', 'run', 'scripts/e2e-invite-fixtures.ts', 'cleanup', `-${runId}@operai.test`], {
      cwd: path.resolve(__dirname, '../../../auth'),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch {
    // never fail a run on cleanup; the rows are harmless @operai.test users
  }
}

// ─── meetings-api ───────────────────────────────────────────────────────────

/** A JSON call to meetings-api as `session`; throws with the Problem body on any unexpected status. */
export async function meetingsCall<T = Json>(
  session: SeededSession,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  route: string,
  body?: unknown,
  expect: number[] = [200, 201, 204],
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${MEETINGS_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!expect.includes(res.status)) {
    throw new Error(`[meetingsFixtures] ${method} ${route} -> ${res.status}: ${text}`)
  }
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers }
}

export interface MeetingRow {
  id: string
  title: string
  status: string
  [key: string]: unknown
}

export interface CreateMeetingInput {
  title: string
  format?: 'in_person' | 'online'
  language?: 'en' | 'it'
  source?: 'recorded' | 'uploaded' | 'text'
  host?: { app: string; entityType: string; entityId: string }
}

/** Creates a meeting through the API (setup only; the journeys that test creation use the form). */
export async function createMeetingViaApi(session: SeededSession, input: CreateMeetingInput): Promise<MeetingRow> {
  const { body } = await meetingsCall<MeetingRow>(session, 'POST', '/meetings', {
    format: 'in_person',
    language: 'en',
    source: 'text',
    ...input,
  })
  return body
}

/**
 * Seeds a `ready` meeting with a transcript the fake pipeline never has to
 * produce: a text meeting (no consent, no audio, AC-3.4) saved through
 * `PUT /meetings/:id/text`.
 */
export async function seedReadyMeeting(
  session: SeededSession,
  title: string,
  text = 'Alice: We agree to ship the pilot in March.\nBob: I will prepare the budget.',
  extra: Partial<CreateMeetingInput> = {},
): Promise<MeetingRow> {
  const meeting = await createMeetingViaApi(session, { title, source: 'text', ...extra })
  await meetingsCall(session, 'PUT', `/meetings/${meeting.id}/text`, { text })
  return (await meetingsCall<MeetingRow>(session, 'GET', `/meetings/${meeting.id}`)).body
}

/** Sets the full participant list (Operai people by id; `PUT` replaces). */
export async function setParticipants(
  creator: SeededSession,
  meetingId: string,
  participants: { userId?: string; name?: string; organisation?: string | null }[],
): Promise<void> {
  await meetingsCall(creator, 'PUT', `/meetings/${meetingId}/participants`, { participants })
}

/** Best-effort removal of a meeting a journey created (creator only). */
export async function deleteMeetingQuietly(session: SeededSession, meetingId: string): Promise<void> {
  try {
    await meetingsCall(session, 'DELETE', `/meetings/${meetingId}`, undefined, [200, 204, 404])
  } catch {
    // cleanup must never fail a run
  }
}

// ─── CRM (a host) ───────────────────────────────────────────────────────────

export interface DealRow {
  id: string
  title: string
  [key: string]: unknown
}

async function crmCall<T = Json>(session: SeededSession, method: 'GET' | 'POST', route: string, body?: unknown) {
  const res = await fetch(`${CRM_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`[meetingsFixtures] CRM ${method} ${route} -> ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** A company and a deal on `welld_ch`, created by an admin (deal:manage everywhere). */
export async function createDealViaApi(admin: SeededSession, title: string): Promise<DealRow> {
  const company = await crmCall<{ id: string }>(admin, 'POST', '/companies', {
    name: `${title} Co`,
    status: 'prospect',
    entity: 'welld_ch',
  })
  return crmCall<DealRow>(admin, 'POST', '/deals', {
    companyId: company.id,
    title,
    currency: 'CHF',
    entity: 'welld_ch',
  })
}

// ─── Browser helpers ────────────────────────────────────────────────────────

/** Injects a seeded session cookie (same shape as applySessionCookie, kept here to keep specs one import). */
export async function signInContext(context: BrowserContext, session: SeededSession): Promise<void> {
  const eq = session.cookieHeader.indexOf('=')
  await context.addCookies([
    {
      name: session.cookieHeader.slice(0, eq),
      value: session.cookieHeader.slice(eq + 1),
      domain: new URL(AUTH_URL).hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ])
}

/**
 * Simulates "meetings-api is down" for ONE page: every request to its origin
 * fails at the network layer (what the browser sees when the process is gone).
 * The harness never stops the real service (shared by every other journey).
 */
export async function blockMeetingsApi(page: Page): Promise<void> {
  await page.route(`${MEETINGS_API_URL}/**`, (route) => route.abort('connectionrefused'))
}

/** Opens the header user menu and follows "My meetings", like a person would. */
export async function openMyMeetingsFromMenu(page: Page, displayName: string): Promise<void> {
  await page.getByRole('button', { name: displayName }).click()
  await page.getByRole('menuitem', { name: 'My meetings' }).click()
}

// ─── axe ────────────────────────────────────────────────────────────────────

interface AxeResults {
  violations: { id: string; impact?: string | null; help: string; nodes: { target: unknown[]; html: string }[] }[]
}

/**
 * Runs axe-core (WCAG 2 A/AA) in the page and returns the violations. The shell
 * has no axe dependency of its own, so the engine is loaded from meetings-ui's
 * devDependency (the same version its component tests use).
 */
export async function axeViolations(page: Page, include?: string): Promise<AxeResults['violations']> {
  const require = createRequire(path.resolve(__dirname, '../../../meetings-ui/package.json'))
  const axePath = require.resolve('axe-core/axe.min.js')
  await page.addScriptTag({ path: axePath })
  const results = await page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe
    return axe.run(scope ? { include: [[scope]] } : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })
  }, include ?? null)
  return (results as AxeResults).violations
}

// ─── Shell origin proxy ─────────────────────────────────────────────────────

/**
 * When `E2E_SHELL_SERVE_PORT` differs from the shell port, the built shell is served on another
 * port while the page must keep the shell's TRUSTED origin (every backend's CORS allow-list names
 * it). Fulfil each request to that origin from the served build. A no-op in the standard
 * topology (Playwright serves the build on the shell port itself).
 */
export async function installShellOriginProxy(context: BrowserContext): Promise<void> {
  const servePort = process.env['E2E_SHELL_SERVE_PORT']
  const shellPort = process.env['E2E_SHELL_PORT'] ?? '5173'
  if (!servePort || servePort === shellPort) return
  await context.route(new RegExp(`^http://localhost:${shellPort}/`), async (route) => {
    const url = new URL(route.request().url())
    url.port = servePort
    const response = await route.fetch({ url: url.toString() })
    await route.fulfill({ response })
  })
}

/**
 * A microphone that cannot hang: `getUserMedia({ audio })` answers with a real MediaStream (a 440 Hz
 * tone from a WebAudio destination), which the page's MediaRecorder encodes to Opus exactly as it
 * would a hardware microphone. Chromium's own fake device (`--use-fake-device-for-media-stream`, set
 * on the `meetings` project) never answers where the OS audio stack is unreachable (a sandboxed
 * macOS shell), so the harness does not depend on it. Video and display capture are untouched.
 */
export async function installFakeMicrophone(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const md = navigator.mediaDevices
    if (!md) return
    const real = md.getUserMedia.bind(md)
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints || !constraints.audio || constraints.video) return real(constraints)
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.frequency.value = 440
      const dest = ctx.createMediaStreamDestination()
      osc.connect(dest)
      osc.start()
      await ctx.resume()
      const stream = dest.stream
      for (const track of stream.getAudioTracks()) {
        const stop = track.stop.bind(track)
        track.stop = () => {
          stop()
          void ctx.close().catch(() => undefined)
        }
      }
      return stream
    }
  })
}

async function prepareContext(context: BrowserContext): Promise<void> {
  await installShellOriginProxy(context)
  await installFakeMicrophone(context)
}

/** `test` whose default context already proxies the shell origin and has a working microphone. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await prepareContext(context)
    await use(context)
  },
})

/** A fresh signed-in browser context for `session` (multi-person journeys). */
export async function personContext(browser: Browser, session: SeededSession): Promise<BrowserContext> {
  const context = await browser.newContext()
  await prepareContext(context)
  await signInContext(context, session)
  return context
}

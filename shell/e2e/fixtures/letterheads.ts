/**
 * Fixtures of the Letterheads configurator journeys (specs/20261116-letterhead-service, T26).
 *
 * Nothing here is a stub. The journeys run the REAL shell, the REAL letterheads-ui remote, the REAL `auth` service and
 * the REAL letterhead-api (the convention of this suite: the other gated-tool specs drive real services too; the one
 * `page.route` use, remote-failure.spec.ts, fakes a FAILURE of the remote, not an API). What a person may do is set the
 * way an administrator sets it, through `auth`'s admin API (`POST /admin/roles`, `PUT /admin/roles/{id}/rules`,
 * `PUT /admin/users/{id}/roles`, `PATCH /admin/users/{id}`), so letterhead-api's own `GET /authz/resolve` call sees
 * exactly what production sees. The only direct database access is the one the whole suite already has, to make the first
 * admin (`grantRole`, helpers/inviteFixtures.ts: there is no "make me admin" endpoint, correctly).
 *
 * Letterhead state (the versions) lives in letterhead-api's own database and is never reset: a run adds versions. Every
 * journey therefore reads the active version it starts from and never assumes a number.
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { applySessionCookie, seedAdminSession, seedUserSession, type SeededSession } from '../helpers/adminSession'

export type { SeededSession }

const trim = (url: string): string => url.replace(/\/$/, '')

export const AUTH_URL = trim(process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001')
export const LETTERHEADS_API_URL = trim(
  process.env['E2E_LETTERHEADS_API_URL'] ?? process.env['VITE_LETTERHEADS_API_URL'] ?? 'http://localhost:8088',
)

export type EntityId = 'welld_it' | 'welld_ch'
export const ENTITY_NAME: Record<EntityId, string> = { welld_it: 'wellD IT', welld_ch: 'wellD CH' }

type Json = Record<string, unknown>

export interface Call<T = Json> {
  status: number
  body: T
}

async function call<T>(
  base: string,
  credential: Record<string, string>,
  method: string,
  route: string,
  body?: unknown,
): Promise<Call<T>> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...credential,
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

/** A JSON call to `auth`'s admin API as `session` (which reads the session cookie). Never throws on a status. */
export const authCall = <T = Json>(session: SeededSession, method: string, route: string, body?: unknown) =>
  call<T>(AUTH_URL, { Cookie: session.cookieHeader }, method, route, body)

/** A JSON call to letterhead-api as `session`. Never throws on a status: the caller asserts what it expects. */
export const lhCall = <T = Json>(session: SeededSession, method: string, route: string, body?: unknown) =>
  call<T>(LETTERHEADS_API_URL, { Authorization: `Bearer ${session.token}` }, method, route, body)

// ─── People and what they may do ──────────────────────────────────────────────────────────────────────────────────────

export type Persona = 'admin' | 'viewer' | 'chManager' | 'nobody'

interface PersonaSpec {
  email: string
  name: string
  /** The role created for it, with its rules; absent: the baseline roles only (or `admin`). */
  role?: { name: string; rules: Array<{ resource: string; action: string; conditions?: Json }> }
  /** Its own entity, which the scope of an entity-conditioned grant reads. */
  entity?: EntityId
}

/** `{ key: 'entity', match: 'user' }`: the caller's own entity (letterhead-api `authz::scope`). */
const OWN_ENTITY = { attributes: [{ key: 'entity', match: 'user' }] }

const PERSONAS: Record<Persona, PersonaSpec> = {
  admin: { email: 'lh-e2e-admin@operai.test', name: 'Letterheads E2E Admin' },
  viewer: {
    email: 'lh-e2e-viewer@operai.test',
    name: 'Letterheads E2E Viewer',
    role: { name: 'e2e-letterheads-viewer', rules: [{ resource: 'letterheads', action: 'access' }] },
  },
  chManager: {
    email: 'lh-e2e-ch-manager@operai.test',
    name: 'Letterheads E2E CH Manager',
    role: {
      name: 'e2e-letterheads-ch-manager',
      rules: [
        { resource: 'letterheads', action: 'access' },
        { resource: 'letterhead', action: 'manage', conditions: OWN_ENTITY },
      ],
    },
    entity: 'welld_ch',
  },
  nobody: { email: 'lh-e2e-nobody@operai.test', name: 'Letterheads E2E Nobody' },
}

export interface People {
  admin: SeededSession
  viewer: SeededSession
  chManager: SeededSession
  nobody: SeededSession
}

interface RoleRow {
  id: string
  name: string
  isSystem: boolean
}
interface UserDetail {
  id: string
  entity: string | null
  roles: Array<{ id: string; name: string }>
}

async function mustOk<T>(what: string, result: Call<T>, ok: number[] = [200, 201]): Promise<T> {
  if (!ok.includes(result.status)) {
    throw new Error(`[letterheads fixtures] ${what} answered ${result.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

/** Creates the role when it does not exist, then full-replaces its rules (idempotent). Returns its id. */
async function ensureRole(admin: SeededSession, spec: NonNullable<PersonaSpec['role']>): Promise<string> {
  const roles = await mustOk('GET /admin/roles', await authCall<RoleRow[]>(admin, 'GET', '/admin/roles'))
  let role = roles.find((r) => r.name === spec.name)
  if (!role) {
    role = await mustOk(
      'POST /admin/roles',
      await authCall<RoleRow>(admin, 'POST', '/admin/roles', {
        name: spec.name,
        description: 'Created by the Letterheads e2e (specs/20261116-letterhead-service T26)',
      }),
    )
  }
  await mustOk('PUT /admin/roles/{id}/rules', await authCall(admin, 'PUT', `/admin/roles/${role.id}/rules`, { rules: spec.rules }))
  return role.id
}

/** Gives `user` the role (keeping the ones it has: the PUT replaces the set) and, when named, its entity. */
async function assign(admin: SeededSession, user: SeededSession, roleId: string, entity?: EntityId): Promise<void> {
  const detail = await mustOk('GET /admin/users/{id}', await authCall<UserDetail>(admin, 'GET', `/admin/users/${user.userId}`))
  const roleIds = new Set(detail.roles.map((r) => r.id))
  if (!roleIds.has(roleId)) {
    roleIds.add(roleId)
    await mustOk(
      'PUT /admin/users/{id}/roles',
      await authCall(admin, 'PUT', `/admin/users/${user.userId}/roles`, { roleIds: [...roleIds] }),
    )
  }
  if (entity !== undefined && detail.entity !== entity) {
    await mustOk('PATCH /admin/users/{id}', await authCall(admin, 'PATCH', `/admin/users/${user.userId}`, { entity }))
  }
}

/**
 * The four people of these journeys, with their grants in place:
 *   admin     the `admin` role: access and an unconditioned change permission;
 *   viewer    `letterheads:access` only;
 *   chManager access, and `letterhead:manage` conditioned on the person's own entity, which is welld_ch;
 *   nobody    the baseline roles only: no letterheads permission.
 * The sessions are minted AFTER the grants, so the JWT each one carries holds the grant's `perm_epoch`.
 */
export async function setUpPeople(): Promise<People> {
  await seedAdminSession(PERSONAS.admin.email, PERSONAS.admin.name)
  // Minted again: the first token predates the admin grant and so does not hold its `perm_epoch`.
  const admin = await seedUserSession(PERSONAS.admin.email, PERSONAS.admin.name)

  const sessions: Partial<People> = { admin }
  for (const persona of ['viewer', 'chManager', 'nobody'] as const) {
    const spec = PERSONAS[persona]
    // The user row is made by the session mint; the grant needs the row. A second mint after the grant refreshes
    // the token (`perm_epoch`), which the first one could not know about.
    const first = await seedUserSession(spec.email, spec.name)
    if (spec.role) {
      const roleId = await ensureRole(admin, spec.role)
      await assign(admin, first, roleId, spec.entity)
    }
    sessions[persona] = spec.role ? await seedUserSession(spec.email, spec.name) : first
  }
  return sessions as People
}

/** A browser context signed in as `session`, in the language asked (the configurator follows the browser's). */
export async function contextFor(browser: Browser, session: SeededSession, locale = 'en-US'): Promise<BrowserContext> {
  const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1000 } })
  await applySessionCookie(context, session)
  return context
}

// ─── The letterhead service, as an API client ────────────────────────────────────────────────────────────────────────

export interface Catalog {
  defaultConfig: Json
  bounds: Json
}

export interface ListRow {
  activeVersion: number | null
  canManage: boolean
}

export interface HistoryRow {
  version: number
  createdBy: { sub: string; name: string }
  createdAt: string
  changedSettings: string[]
  restoredFrom: number | null
}

export async function catalog(session: SeededSession): Promise<Catalog> {
  return mustOk('GET /v1/catalog', await lhCall<Catalog>(session, 'GET', '/v1/catalog'))
}

export async function activeVersion(session: SeededSession, entity: EntityId): Promise<number | null> {
  const list = await mustOk('GET /v1/letterheads', await lhCall<Record<EntityId, ListRow>>(session, 'GET', '/v1/letterheads'))
  return list[entity].activeVersion
}

export async function history(session: SeededSession, entity: EntityId): Promise<HistoryRow[]> {
  return mustOk('GET versions', await lhCall<HistoryRow[]>(session, 'GET', `/v1/letterheads/${entity}/versions`))
}

export async function versionConfig(session: SeededSession, entity: EntityId, n: number): Promise<Json> {
  const row = await mustOk('GET version', await lhCall<{ config: Json }>(session, 'GET', `/v1/letterheads/${entity}/versions/${n}`))
  return row.config
}

/** The members of a configuration these journeys edit (the service's `LetterheadConfig`; the rest is carried untouched). */
export interface ConfigDraft {
  margins: { top: number; bottom: number; left: number; right: number }
  fonts: { body: string; [member: string]: unknown }
  [member: string]: unknown
}

/** A deep copy of `config` with `edit` applied: the way a fixture makes a version that differs from the one before. */
export function withConfig(config: Json, edit: (draft: ConfigDraft) => void): Json {
  const draft = JSON.parse(JSON.stringify(config)) as ConfigDraft
  edit(draft)
  return draft
}

/** Saves `config` on top of the active version as `session` (the service's own save route). Returns the new version. */
export async function saveVersion(session: SeededSession, entity: EntityId, config: Json): Promise<number> {
  const base = (await activeVersion(session, entity)) ?? 0
  const body = await mustOk(
    `POST versions (${entity})`,
    await lhCall<{ version: number }>(session, 'POST', `/v1/letterheads/${entity}/versions`, { baseVersion: base, config }),
  )
  return body.version
}

/**
 * The state every journey starts from: each entity has an active letterhead (the catalog's default when it has none, so
 * a fresh database is not the "no letterhead yet" screen, which a journey of its own would need) with a known footer, so
 * a zone line exists to type in. Nothing is saved when the entity already has one.
 */
export async function ensureLetterheads(admin: SeededSession): Promise<void> {
  const { defaultConfig } = await catalog(admin)
  for (const entity of ['welld_it', 'welld_ch'] as const) {
    if ((await activeVersion(admin, entity)) === null) await saveVersion(admin, entity, defaultConfig)
  }
}

// ─── Driving the configurator ────────────────────────────────────────────────────────────────────────────────────────

export const PREVIEW_REGION = 'Preview of the sample document'

/** The sample document's region (`PagePreview`): its status row, its notices and one figure per page. */
export const previewRegion = (page: Page): Locator => page.getByRole('region', { name: PREVIEW_REGION })

export const pageImages = (page: Page): Locator => previewRegion(page).getByRole('img', { name: /^Page \d+ of \d+$/ })

export const saveButton = (page: Page): Locator => page.getByRole('button', { name: /^Save as version \d+$/ })

export const marginInput = (page: Page, side: 'Top' | 'Bottom' | 'Left' | 'Right'): Locator =>
  page.getByRole('group', { name: 'Margins (mm)' }).getByRole('textbox', { name: side, exact: true })

/** The Italian text of the first line of the default page's footer, left zone. */
export const footerLeftLine1Italian = (page: Page): Locator =>
  page
    .getByRole('region', { name: 'Default page' })
    .getByRole('group', { name: 'Footer', exact: true })
    .getByRole('group', { name: 'Left zone' })
    .getByRole('group', { name: 'Line 1' })
    .getByRole('textbox', { name: 'Text, Italian' })

/**
 * Opens the configurator on `entity` through the shell and waits until the form is there and the first preview is drawn.
 * (Navigation by URL is not a pointer: the keyboard-only journeys use it to arrive.)
 */
export async function openConfigurator(page: Page, entity: EntityId, extra = ''): Promise<void> {
  await page.goto(`/letterheads?entity=${entity}${extra}`)
  await expect(page.getByRole('heading', { name: 'Letterheads', level: 1 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('letterheads-form')).toBeVisible({ timeout: 30_000 })
  await expect(pageImages(page).first()).toBeVisible({ timeout: 30_000 })
}

/** The preview requests the page makes, with the body of each (`{ config, language }`) and when it was made. */
export interface PreviewCall {
  at: number
  language: string
  config: ConfigDraft
  response: Promise<{ status: number; ms: number }>
}

export function recordPreviewCalls(page: Page): PreviewCall[] {
  const calls: PreviewCall[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/v1\/letterheads\/[a-z_]+\/preview/.test(request.url())) return
    const body = request.postDataJSON() as { config: ConfigDraft; language: string }
    const at = Date.now()
    calls.push({
      at,
      language: body.language,
      config: body.config,
      // A journey that ends (and closes its context) while a preview is still being drawn must not leave this promise
      // rejecting with "Target page, context or browser has been closed" (an unhandled rejection that Playwright charges to the
      // test): the call then reads as status 0, which every journey that checks a status still fails on. (QE T45: the Italian
      // journey of specs/20261116 ends right after the first call and failed 6 of 6 runs on a fresh stack for this alone.)
      response: request
        .response()
        .then(async (response) => {
          if (response) await response.finished()
          return { status: response?.status() ?? 0, ms: Date.now() - at }
        })
        .catch(() => ({ status: 0, ms: Date.now() - at })),
    })
  })
  return calls
}

/**
 * Presses Tab (or Shift+Tab) until `target` has the focus, and returns how many presses it took. This is the keyboard-only
 * way to a control: no pointer, no `focus()` call. It fails when the control is not reachable within `max` presses.
 */
export async function tabTo(page: Page, target: Locator, options: { max?: number; reverse?: boolean } = {}): Promise<number> {
  const max = options.max ?? 300
  for (let presses = 0; presses <= max; presses += 1) {
    const focused = await target.evaluate((element) => element === document.activeElement)
    if (focused) return presses
    await page.keyboard.press(options.reverse ? 'Shift+Tab' : 'Tab')
  }
  throw new Error(`[letterheads fixtures] the control was not reached by ${max} presses of Tab`)
}

/** Replaces the value of the focused text input by typing, as a person would (select all, then the new text). */
export async function typeIntoFocused(page: Page, text: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text, { delay: 25 })
}

// ─── Registry values the journeys save (specs/20261117-legal-entities, T43) ───────────────────────────────────────────

/** An IBAN with correct check digits for `country` and `bban` (ISO 13616, mod 97), in its electronic form (no spaces). */
export function ibanWithCheckDigits(country: string, bban: string): string {
  const digits = [...`${bban}${country}00`].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('')
  let rest = 0
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97
  return `${country}${String(98 - rest).padStart(2, '0')}${bban}`
}

/** What a document prints of an IBAN: groups of four characters (AC-5.1). */
export const groupIban = (iban: string): string => iban.replace(/(.{4})(?=.)/g, '$1 ')

/** The optional values of a registry entity (the ones a journey sets to see them printed and should not leave behind). */
export interface OptionalDetails {
  iban: string
  contacts: { it: string; en: string }
}

interface RegistryRead {
  version: number
  legalName: string
  address: { it: string[]; en: string[] }
  vatNumber: string
  iban: string
  contacts: { it: string; en: string }
}

/** The IBAN and the contacts lines `entity` holds now. */
export async function readOptionalDetails(session: SeededSession, entity: EntityId): Promise<OptionalDetails> {
  const read = await mustOk(`GET /legal-entities/${entity}`, await authCall<RegistryRead>(session, 'GET', `/legal-entities/${entity}`))
  return { iban: read.iban, contacts: read.contacts }
}

/**
 * Puts the optional values back as `keep` says, with ONE registry save that carries everything else unchanged; nothing is saved
 * when they are as they were. Registry versions are never deleted, but another journey may assume there is no IBAN to find
 * (the Legal entities journeys of T42 empty it by hand), so a journey that sets one gives it back.
 */
export async function restoreOptionalDetails(session: SeededSession, entity: EntityId, keep: OptionalDetails): Promise<void> {
  const read = await mustOk(`GET /legal-entities/${entity}`, await authCall<RegistryRead>(session, 'GET', `/legal-entities/${entity}`))
  if (read.iban === keep.iban && read.contacts.it === keep.contacts.it && read.contacts.en === keep.contacts.en) return
  await mustOk(
    `POST /legal-entities/${entity}/versions`,
    await authCall(session, 'POST', `/legal-entities/${entity}/versions`, {
      baseVersion: read.version,
      details: {
        legalName: read.legalName,
        address: read.address,
        vatNumber: read.vatNumber,
        iban: keep.iban,
        contacts: keep.contacts,
      },
    }),
  )
}

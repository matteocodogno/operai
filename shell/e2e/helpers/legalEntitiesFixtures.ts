/**
 * Fixtures of the legal-entity registry journeys (specs/20261117-legal-entities, T41; used by T42, T43 and QE T45).
 *
 * Nothing here is a stub. The journeys run the REAL `auth` service, whose registry (`/legal-entities`) holds the legal
 * details of each wellD entity, and every person below is made the way an administrator makes one, through `auth`'s admin
 * API (`POST /admin/roles`, `PUT /admin/roles/{id}/rules`, `PUT /admin/users/{id}/roles`, `PATCH /admin/users/{id}`), so
 * `auth`'s own coverage function (`legalEntities/coverage.ts`) sees exactly what production sees. The one direct database
 * access is the one the whole suite already has, to make the first admin (`grantRole`, helpers/inviteFixtures.ts).
 *
 * What the global setup (`e2e/global-setup.ts`) leaves behind:
 *   - the registry SEEDED BY THE IMPORT (T9, `mise run legal-entities:import`: the CRM's legal details copied into version 1
 *     of each entity; run only when an entity has no version yet, it is idempotent), then
 *   - each entity COMPLETE (AC-1.2: legal name, an address in both languages, a VAT number): where the import left a value
 *     missing (a fresh database has no CRM profile to copy) or invalid, ONE registry save by the admin fixture fills it.
 *     A value that is already there and valid is never replaced, and a complete entity is never saved again: a run adds no
 *     version to a registry that is in order (versions are append-only, AC-4.3: nothing can be undone).
 *   - three people (`setUpLegalEntityPeople`): the admin (the `admin` role: `legal-entity:manage` over every entity), a
 *     `welld_ch` manager (the grant conditioned on the person's own entity, the person's entity attribute `welld_ch`) and a
 *     person with no grant at all. The manager has no `admin:access`: the Admin tool is reached by the capability alone
 *     (AC-4.3).
 *
 * Registry state is shared and never reset: a journey reads the version it starts from and never assumes a number.
 *
 * The notice of a protected change (US-9, T68) is read where a person reads it and where the service records it, never faked:
 * the person's own notification centre through notify-api's `GET /notifications` (as that person), and the delivery outbox of
 * `auth` (`legal_entity_notice`, one row per recipient and channel) through the one direct database access the suite already
 * has to `auth`'s database (the same `bun -e` bridge `grantRole` uses). Neither read ever prints a legal value.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applySessionCookie, seedAdminSession, seedUserSession, type SeededSession } from './adminSession'
import { AUTH_URL, authCall, ibanWithCheckDigits, type Call } from '../fixtures/letterheads'

export type { Call, SeededSession }
export { applySessionCookie }

export type EntityId = 'welld_it' | 'welld_ch'
export const ENTITIES: readonly EntityId[] = ['welld_it', 'welld_ch']

// ─── The registry as an API client ───────────────────────────────────────────────────────────────────────────────────

export type RequiredField = 'legalName' | 'address.it' | 'address.en' | 'vatNumber'
export type DetailField = RequiredField | 'iban' | 'contacts.it' | 'contacts.en'

export interface InvalidItem {
  field: DetailField
  line?: number
  reason: string
  limit?: number
}

/** The wire shape of `GET /legal-entities/{entity}` (auth `read.routes.ts`). Version 0 means "not moved yet". */
export interface RegistryEntity {
  entity: EntityId
  version: number
  updatedAt: string | null
  legalName: string
  address: { it: string[]; en: string[] }
  vatNumber: string
  /** Electronic form; empty when none. */
  iban: string
  /** Groups of four; empty when none. */
  ibanPrint: string
  contacts: { it: string; en: string }
  complete: boolean
  missing: RequiredField[]
  invalid: InvalidItem[]
}

/** The body of a save (`details` of `POST /legal-entities/{entity}/versions`). */
export interface LegalDetails {
  legalName: string
  address: { it: string[]; en: string[] }
  vatNumber: string
  iban: string
  contacts: { it: string; en: string }
}

/**
 * Details that satisfy AC-1.2 to AC-1.4 for each entity, used ONLY to fill what the registry lacks. The IBANs are the
 * published example IBANs of their countries (valid check digits); the names are the ones the CRM e2e fixtures used before the
 * legal details moved. Not the owner's real details: a dev stack's real values, once imported, are never replaced.
 */
export const FIXTURE_DETAILS: Record<EntityId, LegalDetails> = {
  welld_ch: {
    legalName: 'wellD SA',
    address: { it: ['Via Example 1', '6900 Lugano'], en: ['Via Example 1', '6900 Lugano'] },
    vatNumber: 'CHE-123.456.789 MWST',
    iban: 'CH9300762011623852957',
    contacts: { it: '', en: '' },
  },
  welld_it: {
    legalName: 'wellD Italia S.r.l.',
    address: { it: ['Via Esempio 2', '20100 Milano'], en: ['Via Esempio 2', '20100 Milan'] },
    vatNumber: 'IT00000000000',
    iban: 'IT60X0542811101000000123456',
    contacts: { it: '', en: '' },
  },
}

async function mustOk<T>(what: string, result: Call<T>, ok: number[] = [200, 201]): Promise<T> {
  if (!ok.includes(result.status)) {
    // Bodies of the registry carry no legal value on a refusal (problem details name fields, never values), so this is safe to print.
    throw new Error(`[legalEntitiesFixtures] ${what} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}`)
  }
  return result.body
}

/** One entity as `session` reads it (any signed-in person may read the registry). */
export async function getRegistryEntity(session: SeededSession, entity: EntityId): Promise<RegistryEntity> {
  return mustOk(`GET /legal-entities/${entity}`, await authCall<RegistryEntity>(session, 'GET', `/legal-entities/${entity}`))
}

/** Both entities, in the service's order. */
export async function listRegistry(session: SeededSession): Promise<RegistryEntity[]> {
  const body = await mustOk('GET /legal-entities', await authCall<{ items: RegistryEntity[] }>(session, 'GET', '/legal-entities'))
  return body.items
}

/** Whether `read` has every required value and nothing invalid: what a document needs (AC-6.3). */
export const isInOrder = (read: RegistryEntity): boolean => read.version >= 1 && read.complete && read.invalid.length === 0

/**
 * The details a save must carry to bring `read` in order: every value that is present and valid is carried unchanged; a
 * missing required value, or one the registry marks invalid, is replaced by the fixture's. (A pure function: unit-checked.)
 */
export function detailsToComplete(read: RegistryEntity, entity: EntityId): LegalDetails {
  const fixture = FIXTURE_DETAILS[entity]
  const bad = new Set<DetailField>(read.invalid.map((item) => item.field))
  const lacks = (field: DetailField): boolean => bad.has(field) || (read.missing as readonly DetailField[]).includes(field)
  const lines = (field: 'address.it' | 'address.en', have: string[], use: string[]): string[] => (lacks(field) ? [...use] : [...have])
  return {
    legalName: lacks('legalName') ? fixture.legalName : read.legalName,
    address: {
      it: lines('address.it', read.address.it, fixture.address.it),
      en: lines('address.en', read.address.en, fixture.address.en),
    },
    vatNumber: lacks('vatNumber') ? fixture.vatNumber : read.vatNumber,
    // optional values: an invalid one is emptied (an IBAN of ours would be an invention), a valid one is kept
    iban: bad.has('iban') ? '' : read.iban,
    contacts: {
      it: bad.has('contacts.it') ? '' : read.contacts.it,
      en: bad.has('contacts.en') ? '' : read.contacts.en,
    },
  }
}

/**
 * Brings `entity` in order with at most one registry save as `admin` (`legal-entity:manage` over the entity), and returns
 * what the registry then holds. An entity that is already in order is read and left alone. A stale `baseVersion` (409
 * `version_conflict`, another run saving at the same time) is re-read once and re-judged: the other save may have done it.
 * An entity with NO version (the import has not run) is an error here, not something to paper over with a first save: the
 * registry refuses it with `legal_entity_not_moved` and the move is T9's.
 */
export async function ensureRegistryComplete(admin: SeededSession, entity: EntityId): Promise<RegistryEntity> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await getRegistryEntity(admin, entity)
    if (read.version === 0) {
      throw new Error(
        `[legalEntitiesFixtures] ${entity} has no version in the registry: the import has not run ` +
          '(`mise run db:migrate`, then `mise run legal-entities:import`)',
      )
    }
    if (isInOrder(read)) return read
    const saved = await authCall<{ version: number }>(admin, 'POST', `/legal-entities/${entity}/versions`, {
      baseVersion: read.version,
      details: detailsToComplete(read, entity),
    })
    if (saved.status === 409 && attempt === 0) continue
    if (saved.status === 403) {
      throw new Error(
        `[legalEntitiesFixtures] the admin fixture may not manage ${entity} (403): has auth's seed been applied ` +
          '(`cd auth && bun run db:release`: the `admin` role holds `legal-entity:manage`)?',
      )
    }
    await mustOk(`POST /legal-entities/${entity}/versions`, saved)
    const after = await getRegistryEntity(admin, entity)
    if (!isInOrder(after)) {
      throw new Error(`[legalEntitiesFixtures] ${entity} is still not in order after a save: missing ${JSON.stringify(after.missing)}, invalid ${JSON.stringify(after.invalid)}`)
    }
    return after
  }
  throw new Error(`[legalEntitiesFixtures] ${entity}: the registry changed under two saves in a row; run again`)
}

// ─── The import (T9) ─────────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Runs `mise run legal-entities:import` (T9) from the repository root: LOCAL compose databases only (the task builds both URLs
 * itself), applies, prints counts and field names and never a value. It is only called when an entity has no version.
 * Exit 1 (a CRM value differs from the registry's) and exit 2 (`crm_legal_columns_absent`: the move is over) are the
 * script's own answers; whether the registry is usable is judged by reading it afterwards, not by the exit code. A failure
 * to RUN it at all (no `mise`, the stack down) is returned for the caller to put in its message when the registry is still empty.
 */
export function runLegalEntitiesImport(): { ok: boolean; output: string } {
  try {
    const output = execFileSync('mise', ['run', 'legal-entities:import'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    return { ok: true, output }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message }
  }
}

/**
 * The registry as the global setup leaves it: seeded by the import where an entity has no version, then both entities in
 * order. Returns what each entity then holds. Throws, naming what to run, when that cannot be reached.
 */
export async function seedRegistry(admin: SeededSession): Promise<Record<EntityId, RegistryEntity>> {
  let reads = await listRegistry(admin)
  if (reads.some((read) => read.version === 0)) {
    const ran = runLegalEntitiesImport()
    reads = await listRegistry(admin)
    const stillEmpty = reads.filter((read) => read.version === 0).map((read) => read.entity)
    if (stillEmpty.length > 0) {
      throw new Error(
        `[legalEntitiesFixtures] ${stillEmpty.join(', ')} still has no version after \`mise run legal-entities:import\` ` +
          `(${ran.ok ? 'it ran' : 'it failed to run'}); is the compose database up and migrated (\`mise run db:migrate\`)? ` +
          `Its output: ${ran.output.slice(0, 800)}`,
      )
    }
  }
  const seeded = {} as Record<EntityId, RegistryEntity>
  for (const entity of ENTITIES) seeded[entity] = await ensureRegistryComplete(admin, entity)
  return seeded
}

// ─── People ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LegalPersona = 'admin' | 'chManager' | 'nobody'

/** `{ key: 'entity', match: 'user' }`: the grant covers the entity equal to the person's own (auth `grantKind`). */
const OWN_ENTITY = { attributes: [{ key: 'entity', match: 'user' }] }

export const CH_MANAGER_ROLE = 'e2e-legal-entities-ch-manager'

interface PersonaSpec {
  email: string
  name: string
  /** The role created for it, with its rules; absent: the baseline roles only (or `admin`). */
  role?: { name: string; rules: Array<{ resource: string; action: string; conditions?: object }> }
  /** Its entity attribute, which the scope of an entity-conditioned grant reads. */
  entity?: EntityId
}

export const LEGAL_PERSONAS: Record<LegalPersona, PersonaSpec> = {
  admin: { email: 'le-e2e-admin@operai.test', name: 'Legal Entities E2E Admin' },
  chManager: {
    email: 'le-e2e-ch-manager@operai.test',
    name: 'Legal Entities E2E CH Manager',
    role: {
      name: CH_MANAGER_ROLE,
      rules: [{ resource: 'legal-entity', action: 'manage', conditions: OWN_ENTITY }],
    },
    entity: 'welld_ch',
  },
  nobody: { email: 'le-e2e-nobody@operai.test', name: 'Legal Entities E2E Nobody' },
}

export interface LegalEntityPeople {
  /** The `admin` role: manages every entity. */
  admin: SeededSession
  /** `legal-entity:manage` conditioned on the person's own entity, which is `welld_ch`; no `admin:access`. */
  chManager: SeededSession
  /** The baseline roles only: no grant over any entity. */
  nobody: SeededSession
}

interface RoleRow {
  id: string
  name: string
}
interface UserDetail {
  id: string
  entity: string | null
  roles: Array<{ id: string; name: string }>
}

/** Creates the role when it does not exist, then full-replaces its rules (idempotent). Returns its id. */
async function ensureRole(admin: SeededSession, spec: NonNullable<PersonaSpec['role']>): Promise<string> {
  const roles = await mustOk('GET /admin/roles', await authCall<RoleRow[]>(admin, 'GET', '/admin/roles'))
  let role = roles.find((row) => row.name === spec.name)
  if (!role) {
    role = await mustOk(
      'POST /admin/roles',
      await authCall<RoleRow>(admin, 'POST', '/admin/roles', {
        name: spec.name,
        description: 'Created by the legal-entities e2e (specs/20261117-legal-entities T41)',
      }),
    )
  }
  await mustOk('PUT /admin/roles/{id}/rules', await authCall(admin, 'PUT', `/admin/roles/${role.id}/rules`, { rules: spec.rules }), [200, 204])
  return role.id
}

/** Gives `user` the role (keeping the ones it has: the PUT replaces the set) and, when named, its entity. */
async function assign(admin: SeededSession, user: SeededSession, roleId: string, entity?: EntityId): Promise<void> {
  const detail = await mustOk('GET /admin/users/{id}', await authCall<UserDetail>(admin, 'GET', `/admin/users/${user.userId}`))
  const roleIds = new Set(detail.roles.map((row) => row.id))
  if (!roleIds.has(roleId)) {
    roleIds.add(roleId)
    await mustOk('PUT /admin/users/{id}/roles', await authCall(admin, 'PUT', `/admin/users/${user.userId}/roles`, { roleIds: [...roleIds] }), [200, 204])
  }
  if (entity !== undefined && detail.entity !== entity) {
    await mustOk('PATCH /admin/users/{id}', await authCall(admin, 'PATCH', `/admin/users/${user.userId}`, { entity }))
  }
}

/**
 * The three people of the journeys, grants in place (idempotent by e-mail). The sessions are minted AFTER the grants, so the
 * JWT each one carries holds the grant's `perm_epoch`.
 */
export async function setUpLegalEntityPeople(): Promise<LegalEntityPeople> {
  const adminSpec = LEGAL_PERSONAS.admin
  await seedAdminSession(adminSpec.email, adminSpec.name)
  // Minted again: the first token predates the admin grant and so does not hold its `perm_epoch`.
  const admin = await seedUserSession(adminSpec.email, adminSpec.name)

  const sessions: Partial<LegalEntityPeople> = { admin }
  for (const persona of ['chManager', 'nobody'] as const) {
    const spec = LEGAL_PERSONAS[persona]
    // The user row is made by the session mint; the grant needs the row. A second mint after the grant refreshes the token.
    const first = await seedUserSession(spec.email, spec.name)
    if (spec.role) {
      const roleId = await ensureRole(admin, spec.role)
      await assign(admin, first, roleId, spec.entity)
    }
    sessions[persona] = spec.role ? await seedUserSession(spec.email, spec.name) : first
  }
  return sessions as LegalEntityPeople
}


// ─── US-9: protected details and their notice (T68) ──────────────────────────────────────────────────────────────────────

/** The time the spec gives a notice to be handed over for sending after the save (AC-9.7). */
export const NOTICE_WITHIN_MS = 60_000

const NOTIFY_API_URL = (
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'
).replace(/\/$/, '')

const AUTH_DIR = fileURLToPath(new URL('../../../auth/', import.meta.url))
const NOTIFY_API_DIR = fileURLToPath(new URL('../../../notify-api/', import.meta.url))

/** An IBAN in groups of four, upper case: how the page shows one (AC-5.1). Empty stays empty. */
export const groupIban = (iban: string): string =>
  iban.replace(/\s+/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')

/** The last four characters of an IBAN in its electronic form: the one part of it a notice may show (AC-9.11). */
export const ibanLast4 = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase().slice(-4)

let ibanCounter = 0

/**
 * A valid Swiss IBAN (correct check digits) that no earlier call and no earlier run has produced: its 12 account digits come
 * from the clock and a counter. Electronic form. The registry only checks the shape and the check digits (AC-1.4).
 */
export function freshIban(): string {
  ibanCounter += 1
  const account = String((Date.now() * 1000 + ibanCounter) % 1_000_000_000_000).padStart(12, '0')
  return ibanWithCheckDigits('CH', `00762${account}`)
}

/** How a person might type an IBAN: lower case, spaced in groups of five (not four), as read from a letter. */
export const typedIban = (iban: string): string => iban.toLowerCase().replace(/(.{5})(?=.)/g, '$1 ')

// ── the notification centre, as the person (notify-api) ──

export interface NoticeItem {
  id: string
  title: string
  body: string
  severity: string
  originApp: string
  link?: { href: string; label?: string }
  it: { title: string; body: string } | null
  readAt: string | null
  createdAt: string
}

/** A bearer token for `session`, minted now (the one the seeding minted may be old by the time a long journey asks). */
async function bearerOf(session: SeededSession): Promise<string> {
  const response = await fetch(`${AUTH_URL}/auth/token`, { headers: { Cookie: session.cookieHeader } })
  if (!response.ok) throw new Error(`[legalEntitiesFixtures] GET /auth/token answered ${response.status}`)
  return ((await response.json()) as { token: string }).token
}

/** The newest notifications of `session` (notify-api scopes the list to the caller). */
export async function notificationsOf(session: SeededSession, limit = 100): Promise<NoticeItem[]> {
  const response = await fetch(`${NOTIFY_API_URL}/notifications?limit=${limit}`, {
    headers: { Authorization: `Bearer ${await bearerOf(session)}` },
  })
  if (!response.ok) throw new Error(`[legalEntitiesFixtures] GET /notifications answered ${response.status}`)
  return ((await response.json()) as { items: NoticeItem[] }).items
}

/** The link every notice of `entity` carries: the history of that entity on the Legal entities page (AC-9.11). */
export const historyLink = (entity: EntityId): string => `/admin/legal-entities?entity=${entity}&view=history`

/** Whether `item` is the notice of version `version` of `entity` (the history link, and the version it names in its body). */
export const isNoticeOf = (item: NoticeItem, entity: EntityId, version: number): boolean =>
  item.originApp === 'admin' && item.link?.href === historyLink(entity) && item.body.includes(`New version: ${version}.`)

/**
 * Waits for the notice of `version` to be in `session`'s notification centre and returns it with the time it took from
 * `since` (a `Date.now()` taken just before the save was confirmed). Throws, with the elapsed time, past `within`.
 */
export async function waitForNotice(
  session: SeededSession,
  entity: EntityId,
  version: number,
  since: number,
  within = NOTICE_WITHIN_MS,
): Promise<{ notice: NoticeItem; elapsedMs: number }> {
  for (;;) {
    const found = (await notificationsOf(session)).find((item) => isNoticeOf(item, entity, version))
    if (found) return { notice: found, elapsedMs: Date.now() - since }
    if (Date.now() - since > within) {
      throw new Error(`[legalEntitiesFixtures] no notice of ${entity} version ${version} in ${session.email}'s notification centre ${Math.round((Date.now() - since) / 1000)} s after the save`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** Whether `session`'s notification centre holds the notice of `version` of `entity` right now. */
export async function hasNotice(session: SeededSession, entity: EntityId, version: number): Promise<boolean> {
  return (await notificationsOf(session)).some((item) => isNoticeOf(item, entity, version))
}

// ── the delivery outbox of auth, and notify-api's email deliveries ──

export interface OutboxRow {
  recipient: string
  recipientKind: string
  channel: string
  status: string
  attempts: number
  lastReason: string | null
}

/** The last JSON line a script printed (Prisma's dev logging shares stdout). */
function lastJson(output: string, what: string): unknown {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{') || l.startsWith('['))
  if (!line) throw new Error(`[legalEntitiesFixtures] no JSON from ${what}: ${output.slice(0, 400)}`)
  return JSON.parse(line)
}

/**
 * The outbox rows `auth` wrote for one version (`legal_entity_notice`: one per recipient and channel, stored in the version's
 * transaction). Direct to `auth`'s database (the one access the suite already has: `DATABASE_URL` of `auth`, as `grantRole`
 * reads it). No value is in a row: ids, a channel, a status, a closed reason.
 */
export function noticeRows(entity: EntityId, version: number): OutboxRow[] {
  const script = `
    import { db } from ${JSON.stringify(`${AUTH_DIR}src/lib/db`)}
    const rows = await db.legalEntityNotice.findMany({
      where: { entity: ${JSON.stringify(entity)}, version: ${Number(version)} },
      select: { recipient: true, recipientKind: true, channel: true, status: true, attempts: true, lastReason: true },
      orderBy: [{ recipient: 'asc' }, { channel: 'asc' }],
    })
    console.log(JSON.stringify(rows))
    await db.$disconnect()
  `
  const output = execFileSync('bun', ['-e', script], { cwd: AUTH_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  return lastJson(output, 'the notice outbox read') as OutboxRow[]
}

/** The rows of one recipient. */
export const rowsOf = (rows: readonly OutboxRow[], userId: string): OutboxRow[] => rows.filter((row) => row.recipient === userId)

/**
 * Waits until every row of the version has been tried and either is delivered or says why not (an email channel that notify-api
 * says is not configured stays pending with that reason), within `within` of `since`. Returns the rows then.
 */
export async function waitForOutbox(entity: EntityId, version: number, since: number, within = NOTICE_WITHIN_MS): Promise<OutboxRow[]> {
  for (;;) {
    const rows = noticeRows(entity, version)
    if (rows.length > 0 && rows.every((row) => row.status === 'delivered' || (row.attempts >= 1 && row.lastReason !== null))) return rows
    if (Date.now() - since > within) {
      throw new Error(
        `[legalEntitiesFixtures] the notices of ${entity} version ${version} are not all tried ${Math.round((Date.now() - since) / 1000)} s after the save: ` +
          JSON.stringify(rows.map((row) => `${row.channel}:${row.status}:${row.attempts}:${row.lastReason ?? '-'}`)),
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/**
 * The `email_delivery` rows notify-api recorded for the `legal_entity_change` template since `sinceIso`, or `null` when the
 * database of notify-api is not named (`E2E_NOTIFY_DATABASE_URL`). With `EMAIL_ENABLED=false` (the local default) notify-api
 * stubs the send and still records a `sent` row with no provider: nothing leaves the machine. The row holds the address, the
 * template, a status and an error: never the content.
 */
export function emailDeliveriesSince(sinceIso: string): Array<{ to: string; status: string; error: string | null; callerSub: string | null }> | null {
  const url = process.env['E2E_NOTIFY_DATABASE_URL']
  if (!url) return null
  const script = `
    import { db } from ${JSON.stringify(`${NOTIFY_API_DIR}src/lib/db`)}
    const rows = await db.emailDelivery.findMany({
      where: { template: 'legal_entity_change', createdAt: { gte: new Date(${JSON.stringify(sinceIso)}) } },
      select: { to: true, status: true, error: true, callerSub: true },
    })
    console.log(JSON.stringify(rows))
    await db.$disconnect()
  `
  const output = execFileSync('bun', ['-e', script], {
    cwd: NOTIFY_API_DIR,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url },
  })
  return lastJson(output, 'the email deliveries read') as Array<{ to: string; status: string; error: string | null; callerSub: string | null }>
}

/** How many audit entries the registry holds for `entity` (an administrator reads them: AC-2.5, AC-9.15). */
export async function auditCount(admin: SeededSession, entity: EntityId): Promise<number> {
  const result = await authCall<{ total: number }>(admin, 'GET', `/admin/audit?targetType=legal_entity&targetId=${entity}&pageSize=1`)
  if (result.status !== 200) throw new Error(`[legalEntitiesFixtures] GET /admin/audit answered ${result.status}`)
  return result.body.total
}

/**
 * Every value a notice or a record of one must never carry (AC-9.12) for the two versions it is about: the full IBAN of each (electronic and
 * grouped), the legal name, the VAT number, every address line and the contacts lines. Values too short to be told from the words
 * around them (under 6 characters) are left out.
 */
export function forbiddenValues(...reads: readonly RegistryEntity[]): string[] {
  const values = new Set<string>()
  for (const read of reads) {
    for (const value of [read.legalName, read.vatNumber, read.iban, read.ibanPrint, ...read.address.it, ...read.address.en, read.contacts.it, read.contacts.en]) {
      if (value.trim().length >= 6) values.add(value)
    }
  }
  return [...values]
}

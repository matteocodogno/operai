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
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applySessionCookie, seedAdminSession, seedUserSession, type SeededSession } from './adminSession'
import { authCall, type Call } from '../fixtures/letterheads'

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

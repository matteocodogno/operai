/**
 * legalEntitiesApi — typed client of the auth service's legal-entity registry (T34, specs/20261117-legal-entities,
 * plan "API contracts" with amendments E1, E2, E5, E6).
 *
 * Conventions are `adminApi.ts`'s (base URL from `shell/session`'s `getAuthBaseUrl()`, `apiFetch` for the Bearer
 * token and the 401 refresh, RFC 7807 problems thrown as `ApiError`), with three differences:
 *
 *  - Every answer is **parsed**, not cast. The registry's answer is a contract shared with crm-api and
 *    letterhead-api (the fixture `specs/20261117-legal-entities/fixtures/legal-entities.json`), and a page that
 *    renders `undefined.map` on drift is worse than one that says "could not be loaded". A shape this build
 *    cannot read throws `LegalEntityContractError` (a failed load: Banner + Retry). Members it does not know are
 *    ignored, so an additive change on the server never breaks the page.
 *  - Errors are `LegalEntityApiError`, an `ApiError` that also carries `problems[]` of a 422
 *    `invalid_legal_entity` (E5) and `currentVersion` of a 409 `version_conflict` (AC-2.6). Branch on `status` and
 *    `code`, never on the prose.
 *  - A save sends the details exactly as the form holds them: blank address lines are NOT removed here, because
 *    `problems[].line` counts positions in the submitted array (E5).
 *
 * `getManageable` is the one read of "which entities may I change" (E2). It does not decide anything by itself:
 * a caller treats any failure as "may not" (fails closed).
 */
import { apiFetch, getAuthBaseUrl } from 'shell/session'
import { ApiError } from './adminApi'
import type { ApiProblem } from './adminApi'
import { LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_IDS, PROBLEM_REASONS, isLegalEntityId } from './legalEntityModel'
import type {
  LegalEntity,
  LegalEntityDetails,
  LegalEntityField,
  LegalEntityId,
  LegalEntityProblem,
  LegalEntityVersion,
  ProblemReason,
  VersionAction,
  VersionAuthor,
  VersionListItem,
} from './legalEntityModel'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A non-2xx answer. `problems` only on a 422 `invalid_legal_entity`; `currentVersion` only on a 409 `version_conflict`. */
export class LegalEntityApiError extends ApiError {
  readonly problems: LegalEntityProblem[] | undefined
  readonly currentVersion: number | undefined

  constructor(problem: ApiProblem, extras: { problems?: LegalEntityProblem[]; currentVersion?: number } = {}) {
    super(problem)
    this.name = 'LegalEntityApiError'
    this.problems = extras.problems
    this.currentVersion = extras.currentVersion
  }
}

/** A 2xx answer this build cannot read. `path` names the member (never a value: answers carry company data). */
export class LegalEntityContractError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`The registry answered in a shape this page does not know (${path})`)
    this.name = 'LegalEntityContractError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

const fail = (path: string): never => {
  throw new LegalEntityContractError(path)
}

const record = (value: unknown, path: string): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : fail(path)

const text = (value: unknown, path: string): string => (typeof value === 'string' ? value : fail(path))

const integer = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isInteger(value) ? value : fail(path)

const bool = (value: unknown, path: string): boolean => (typeof value === 'boolean' ? value : fail(path))

const list = (value: unknown, path: string): unknown[] => (Array.isArray(value) ? value : fail(path))

const textList = (value: unknown, path: string): string[] =>
  list(value, path).map((item, index) => text(item, `${path}[${index}]`))

const nullableText = (value: unknown, path: string): string | null => (value === null ? null : text(value, path))

const nullableInteger = (value: unknown, path: string): number | null => (value === null ? null : integer(value, path))

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail(path)

const fieldOf = (value: unknown, path: string): LegalEntityField => oneOf(value, LEGAL_ENTITY_FIELDS, path)

const fieldList = (value: unknown, path: string): LegalEntityField[] =>
  list(value, path).map((item, index) => fieldOf(item, `${path}[${index}]`))

const VERSION_ACTIONS: readonly VersionAction[] = ['import', 'save', 'restore']

const parseProblem = (value: unknown, path: string): LegalEntityProblem => {
  const raw = record(value, path)
  const problem: LegalEntityProblem = {
    field: fieldOf(raw.field, `${path}.field`),
    reason: oneOf<ProblemReason>(raw.reason, PROBLEM_REASONS, `${path}.reason`),
  }
  if (raw.line !== undefined) problem.line = integer(raw.line, `${path}.line`)
  if (raw.limit !== undefined) problem.limit = integer(raw.limit, `${path}.limit`)
  return problem
}

const parseProblems = (value: unknown, path: string): LegalEntityProblem[] =>
  list(value, path).map((item, index) => parseProblem(item, `${path}[${index}]`))

const parseAuthor = (value: unknown, path: string): VersionAuthor | null => {
  if (value === null) return null
  const raw = record(value, path)
  return { id: text(raw.id, `${path}.id`), name: text(raw.name, `${path}.name`) }
}

const parseLangs = <T>(value: unknown, path: string, one: (item: unknown, path: string) => T) => {
  const raw = record(value, path)
  return { it: one(raw.it, `${path}.it`), en: one(raw.en, `${path}.en`) }
}

const parseDetails = (raw: Json, path: string): LegalEntityDetails => ({
  legalName: text(raw.legalName, `${path}.legalName`),
  address: parseLangs(raw.address, `${path}.address`, textList),
  vatNumber: text(raw.vatNumber, `${path}.vatNumber`),
  iban: text(raw.iban, `${path}.iban`),
  contacts: parseLangs(raw.contacts, `${path}.contacts`, text),
})

/** One `LegalEntity` of the one serializer (plan decision 2). */
export const parseLegalEntity = (value: unknown, path = 'entity'): LegalEntity => {
  const raw = record(value, path)
  return {
    entity: oneOf<LegalEntityId>(raw.entity, LEGAL_ENTITY_IDS, `${path}.entity`),
    version: integer(raw.version, `${path}.version`),
    updatedAt: nullableText(raw.updatedAt, `${path}.updatedAt`),
    ...parseDetails(raw, path),
    ibanPrint: text(raw.ibanPrint, `${path}.ibanPrint`),
    complete: bool(raw.complete, `${path}.complete`),
    missing: fieldList(raw.missing, `${path}.missing`),
    invalid: parseProblems(raw.invalid, `${path}.invalid`),
  }
}

/**
 * `GET /legal-entities`: both entities, always, in the page's fixed order (AC-1.1). An entity name this build
 * does not know is ignored; a missing one is a contract failure (the page has a tab for each).
 */
export const parseLegalEntityList = (value: unknown): LegalEntity[] => {
  const items = list(record(value, 'list').items, 'items').map((item, index) =>
    isLegalEntityId(record(item, `items[${index}]`).entity) ? parseLegalEntity(item, `items[${index}]`) : null,
  )
  return LEGAL_ENTITY_IDS.map((id) => items.find((item) => item?.entity === id) ?? fail(`items(${id})`))
}

const parseVersionMeta = (raw: Json, path: string) => ({
  action: oneOf<VersionAction>(raw.action, VERSION_ACTIONS, `${path}.action`),
  restoredFrom: nullableInteger(raw.restoredFrom, `${path}.restoredFrom`),
  createdBy: parseAuthor(raw.createdBy, `${path}.createdBy`),
  createdAt: text(raw.createdAt, `${path}.createdAt`),
})

export const parseVersionList = (value: unknown): VersionListItem[] =>
  list(record(value, 'list').items, 'items').map((item, index) => {
    const path = `items[${index}]`
    const raw = record(item, path)
    return {
      version: integer(raw.version, `${path}.version`),
      ...parseVersionMeta(raw, path),
      changedFields: fieldList(raw.changedFields, `${path}.changedFields`),
      restorable: bool(raw.restorable, `${path}.restorable`),
    }
  })

export const parseLegalEntityVersion = (value: unknown): LegalEntityVersion => {
  const raw = record(value, 'version')
  return { ...parseLegalEntity(raw, 'version'), ...parseVersionMeta(raw, 'version') }
}

/** The entities the caller may change (E2); a name this build does not know is dropped. */
export const parseManageable = (value: unknown): LegalEntityId[] => {
  const names = list(record(value, 'manageable').entities, 'entities').map((item, index) =>
    text(item, `entities[${index}]`),
  )
  return LEGAL_ENTITY_IDS.filter((id) => names.includes(id))
}

export type SaveResult = {
  version: number
  /** `false`: the details were already the current version, so nothing was created (AC-2.1). */
  created: boolean
  /** The entity as it now stands, normalised: the form reloads from it. */
  entity: LegalEntity
}

export const parseSaveResult = (value: unknown): SaveResult => {
  const raw = record(value, 'result')
  return {
    version: integer(raw.version, 'result.version'),
    created: bool(raw.created, 'result.created'),
    entity: parseLegalEntity(raw.entity, 'result.entity'),
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const authBase = (): string => getAuthBaseUrl()

/** A non-2xx answer as a `LegalEntityApiError`. A body that is not a problem still gives an error with the status. */
const throwFromResponse = async (response: Response): Promise<never> => {
  let body: Json = {}
  try {
    const parsed: unknown = await response.json()
    body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : {}
  } catch {
    body = {}
  }
  const problem: ApiProblem = {
    type: typeof body.type === 'string' ? body.type : `https://httpstatuses.com/${response.status}`,
    title: typeof body.title === 'string' ? body.title : response.statusText || String(response.status),
    status: typeof body.status === 'number' ? body.status : response.status,
    detail: typeof body.detail === 'string' ? body.detail : undefined,
    instance: typeof body.instance === 'string' ? body.instance : undefined,
    code: typeof body.code === 'string' ? body.code : undefined,
  }
  const extras: { problems?: LegalEntityProblem[]; currentVersion?: number } = {}
  if (typeof body.currentVersion === 'number' && Number.isInteger(body.currentVersion)) {
    extras.currentVersion = body.currentVersion
  }
  if (problem.code === 'invalid_legal_entity') {
    // Only a list this build can read in full is kept: a half-read list would under-count in the summary.
    try {
      extras.problems = parseProblems(body.problems, 'problems')
    } catch {
      extras.problems = undefined
    }
  }
  throw new LegalEntityApiError(problem, extras)
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return fail('body')
  }
}

const getJson = async (path: string): Promise<unknown> => {
  const response = await apiFetch(`${authBase()}${path}`)
  if (!response.ok) return throwFromResponse(response)
  return readJson(response)
}

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const response = await apiFetch(`${authBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) return throwFromResponse(response)
  return readJson(response)
}

const entityPath = (entity: LegalEntityId): string => `/legal-entities/${encodeURIComponent(entity)}`

const versionNumber = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('A version is a whole number from 1')
  return n
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /legal-entities/manageable: the entities the caller may change (E2). 401 when signed out. */
export const getManageable = async (): Promise<LegalEntityId[]> =>
  parseManageable(await getJson('/legal-entities/manageable'))

/** GET /legal-entities: both entities, `welld_it` then `welld_ch`. Live: auth answers `no-store`. */
export const listLegalEntities = async (): Promise<LegalEntity[]> =>
  parseLegalEntityList(await getJson('/legal-entities'))

/** GET /legal-entities/{entity}. */
export const getLegalEntity = async (entity: LegalEntityId): Promise<LegalEntity> =>
  parseLegalEntity(await getJson(entityPath(entity)))

/** GET /legal-entities/{entity}/versions: every version, newest first (AC-2.2). 403 without a covered entity. */
export const listVersions = async (entity: LegalEntityId): Promise<VersionListItem[]> =>
  parseVersionList(await getJson(`${entityPath(entity)}/versions`))

/** GET /legal-entities/{entity}/versions/{n} (AC-2.3). 404 `version_not_found`. */
export const getVersion = async (entity: LegalEntityId, n: number): Promise<LegalEntityVersion> =>
  parseLegalEntityVersion(await getJson(`${entityPath(entity)}/versions/${versionNumber(n)}`))

/**
 * POST /legal-entities/{entity}/versions. `details` goes as given, blank address lines included (E5).
 * 201 `created: true`; 200 `created: false` (no-op, AC-2.1). Throws `LegalEntityApiError`: 403 `forbidden`,
 * 409 `version_conflict` (+ `currentVersion`) or `legal_entity_not_moved`, 422 `invalid_legal_entity`
 * (+ `problems`) or `invalid_request`.
 */
export const saveLegalEntity = async (
  entity: LegalEntityId,
  input: { baseVersion: number; details: LegalEntityDetails },
): Promise<SaveResult> => {
  const { baseVersion, details } = input
  return parseSaveResult(
    await postJson(`${entityPath(entity)}/versions`, {
      baseVersion,
      details: {
        legalName: details.legalName,
        address: { it: details.address.it, en: details.address.en },
        vatNumber: details.vatNumber,
        iban: details.iban,
        contacts: { it: details.contacts.it, en: details.contacts.en },
      },
    }),
  )
}

/** POST /legal-entities/{entity}/versions/{n}/restore (AC-2.4). Refusals as a save, plus 404 `version_not_found`. */
export const restoreVersion = async (entity: LegalEntityId, n: number, baseVersion: number): Promise<SaveResult> =>
  parseSaveResult(await postJson(`${entityPath(entity)}/versions/${versionNumber(n)}/restore`, { baseVersion }))

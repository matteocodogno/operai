/**
 * The registry client (T34, specs/20261117-legal-entities; AC-1.2, AC-1.3, AC-2.6, AC-7.3): it parses the shared
 * contract fixture, sends a save exactly as the form holds it (E5), and turns every refusal into a typed error.
 * Same strategy as adminApi.test.ts: `shell/session`'s `apiFetch` is a mock and tests inspect what was sent.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './adminApi'
import {
  LegalEntityApiError,
  LegalEntityContractError,
  getLegalEntity,
  getManageable,
  getVersion,
  listLegalEntities,
  listVersions,
  restoreVersion,
  saveLegalEntity,
} from './legalEntitiesApi'
import type { LegalEntityDetails } from './legalEntityModel'

const AUTH = 'http://auth.test'

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../specs/20261117-legal-entities/fixtures/legal-entities.json', import.meta.url)),
    'utf8',
  ),
) as { items: Array<Record<string, unknown>> }
const FIXTURE_IT = FIXTURE.items[0]!
const FIXTURE_CH = FIXTURE.items[1]!

const mockFetch = vi.mocked(apiFetch)

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const problemJson = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

const lastCall = () => {
  const call = mockFetch.mock.calls.at(-1)!
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

beforeEach(() => {
  // Braces matter: a function returned from a hook is run by vitest as its cleanup, and `mockReset()` returns the mock.
  mockFetch.mockReset()
})

describe('the shared contract fixture', () => {
  it('is parsed by listLegalEntities: both entities, every member, in the fixed order', async () => {
    mockFetch.mockResolvedValue(json(FIXTURE))
    const items = await listLegalEntities()
    expect(lastCall().url).toBe(`${AUTH}/legal-entities`)
    expect(items.map((e) => e.entity)).toEqual(['welld_it', 'welld_ch'])
    expect(items).toEqual(FIXTURE.items)
  })

  it('carries the moved entity of AC-7.3: 5 address lines, a 121-character line, a bad IBAN, in `invalid` (E6)', async () => {
    mockFetch.mockResolvedValue(json(FIXTURE))
    const [it] = await listLegalEntities()
    expect(it!.complete).toBe(true)
    expect(it!.address.it).toHaveLength(5)
    expect(it!.invalid).toEqual([
      { field: 'address.it', line: 2, reason: 'too_long', limit: 120 },
      { field: 'address.it', reason: 'too_many_lines', limit: 4 },
      { field: 'iban', reason: 'iban_check_digits' },
    ])
  })

  it('is parsed by getLegalEntity (one entity, the entity in the path)', async () => {
    mockFetch.mockResolvedValue(json(FIXTURE_CH))
    const entity = await getLegalEntity('welld_ch')
    expect(lastCall().url).toBe(`${AUTH}/legal-entities/welld_ch`)
    expect(entity).toEqual(FIXTURE_CH)
  })

  it('is parsed as a version, with its provenance (AC-2.3)', async () => {
    mockFetch.mockResolvedValue(
      json({
        ...FIXTURE_CH,
        action: 'restore',
        restoredFrom: 1,
        createdBy: { id: 'u_1', name: 'Ada' },
        createdAt: '2026-11-17T10:12:00.000Z',
      }),
    )
    const version = await getVersion('welld_ch', 3)
    expect(lastCall().url).toBe(`${AUTH}/legal-entities/welld_ch/versions/3`)
    expect(version).toMatchObject({
      entity: 'welld_ch',
      version: 3,
      action: 'restore',
      restoredFrom: 1,
      createdBy: { name: 'Ada' },
    })
  })
})

describe('parsing is strict about what the page relies on and lenient about the rest', () => {
  it('always returns both entities in the fixed order, whatever order the server used', async () => {
    mockFetch.mockResolvedValue(json({ items: [FIXTURE_CH, FIXTURE_IT] }))
    expect((await listLegalEntities()).map((e) => e.entity)).toEqual(['welld_it', 'welld_ch'])
  })

  it('ignores members and entities it does not know (an additive server change must not break the page)', async () => {
    const extra = { ...clone(FIXTURE_CH), futureMember: { a: 1 } }
    const unknownEntity = { ...clone(FIXTURE_CH), entity: 'welld_de' }
    mockFetch.mockResolvedValue(json({ items: [FIXTURE_IT, unknownEntity, extra], more: true }))
    const items = await listLegalEntities()
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual(FIXTURE_CH)
  })

  it('a missing entity is a contract failure (the page has a tab for each)', async () => {
    mockFetch.mockResolvedValue(json({ items: [FIXTURE_IT] }))
    await expect(listLegalEntities()).rejects.toBeInstanceOf(LegalEntityContractError)
  })

  it.each([
    ['a missing `complete`', (e: Record<string, unknown>) => delete e.complete],
    ['a non-array `missing`', (e: Record<string, unknown>) => (e.missing = 'legalName')],
    ['a non-string address line', (e: Record<string, unknown>) => (e.address = { it: [1], en: [] })],
    ['an address without a language', (e: Record<string, unknown>) => (e.address = { it: [] })],
    ['a missing `contacts`', (e: Record<string, unknown>) => delete e.contacts],
    ['a fractional version', (e: Record<string, unknown>) => (e.version = 1.5)],
    [
      'an unknown `invalid` reason',
      (e: Record<string, unknown>) => (e.invalid = [{ field: 'iban', reason: 'new_reason' }]),
    ],
    [
      'an unknown `invalid` field',
      (e: Record<string, unknown>) => (e.invalid = [{ field: 'swift', reason: 'required' }]),
    ],
    [
      'a non-integer `invalid` line',
      (e: Record<string, unknown>) => (e.invalid = [{ field: 'address.it', line: '2', reason: 'too_long' }]),
    ],
  ])('refuses %s with a LegalEntityContractError that names the member, not a value', async (_label, mutate) => {
    const broken = clone(FIXTURE_CH)
    mutate(broken)
    mockFetch.mockResolvedValue(json(broken))
    const error = await getLegalEntity('welld_ch').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LegalEntityContractError)
    expect((error as LegalEntityContractError).path).toMatch(/^entity\./)
    expect((error as Error).message).not.toContain('wellD SA')
  })

  it('refuses a 200 whose body is not JSON', async () => {
    mockFetch.mockResolvedValue(new Response('<html>', { status: 200 }))
    await expect(getLegalEntity('welld_it')).rejects.toBeInstanceOf(LegalEntityContractError)
  })
})

describe('an entity that is not moved yet (version 0, AC-7.1)', () => {
  it('parses: empty values, no `updatedAt`, incomplete, every required value missing', async () => {
    const notMoved = {
      entity: 'welld_ch',
      version: 0,
      updatedAt: null,
      legalName: '',
      address: { it: [], en: [] },
      vatNumber: '',
      iban: '',
      ibanPrint: '',
      contacts: { it: '', en: '' },
      complete: false,
      missing: ['legalName', 'address.it', 'address.en', 'vatNumber'],
      invalid: [],
    }
    mockFetch.mockResolvedValue(json({ items: [FIXTURE_IT, notMoved] }))
    const [, ch] = await listLegalEntities()
    expect(ch).toEqual(notMoved)
  })
})

describe('getManageable (E2)', () => {
  it('reads the entities the caller may change, in the fixed order, dropping names it does not know', async () => {
    mockFetch.mockResolvedValue(json({ entities: ['welld_ch', 'welld_it', 'welld_de'] }))
    expect(await getManageable()).toEqual(['welld_it', 'welld_ch'])
    expect(lastCall().url).toBe(`${AUTH}/legal-entities/manageable`)
  })

  it('an empty answer is "none"; a malformed one is a failure the caller treats as "may not"', async () => {
    mockFetch.mockResolvedValue(json({ entities: [] }))
    expect(await getManageable()).toEqual([])
    mockFetch.mockResolvedValue(json({ entities: 'welld_ch' }))
    await expect(getManageable()).rejects.toBeInstanceOf(LegalEntityContractError)
  })

  it('a 401 or 403 is a typed error, not an empty list', async () => {
    mockFetch.mockResolvedValue(problemJson(401, { title: 'Unauthorized' }))
    await expect(getManageable()).rejects.toMatchObject({ status: 401 })
  })
})

describe('versions (E1)', () => {
  it('lists every version newest first with `restorable`, who and what changed', async () => {
    const items = [
      {
        version: 3,
        action: 'save',
        restoredFrom: null,
        createdBy: { id: 'u_1', name: 'Ada' },
        createdAt: '2026-11-17T10:12:00.000Z',
        changedFields: ['iban'],
        restorable: true,
      },
      {
        version: 1,
        action: 'import',
        restoredFrom: null,
        createdBy: null,
        createdAt: '2026-11-17T09:00:00.000Z',
        changedFields: ['legalName', 'address.it', 'address.en'],
        restorable: false,
      },
    ]
    mockFetch.mockResolvedValue(json({ items }))
    expect(await listVersions('welld_ch')).toEqual(items)
    expect(lastCall().url).toBe(`${AUTH}/legal-entities/welld_ch/versions`)
  })

  it('a version item without `restorable` is a contract failure (the history disables Restore by it)', async () => {
    mockFetch.mockResolvedValue(
      json({
        items: [
          { version: 1, action: 'import', restoredFrom: null, createdBy: null, createdAt: 'x', changedFields: [] },
        ],
      }),
    )
    await expect(listVersions('welld_it')).rejects.toBeInstanceOf(LegalEntityContractError)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('never calls the API for version %s', async (n) => {
    await expect(getVersion('welld_it', n)).rejects.toBeInstanceOf(RangeError)
    await expect(restoreVersion('welld_it', n, 2)).rejects.toBeInstanceOf(RangeError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('a missing version is a 404 `version_not_found`', async () => {
    mockFetch.mockResolvedValue(problemJson(404, { code: 'version_not_found' }))
    await expect(getVersion('welld_it', 99)).rejects.toMatchObject({ status: 404, code: 'version_not_found' })
  })
})

describe('saveLegalEntity', () => {
  const details: LegalEntityDetails = {
    legalName: ' wellD SA ',
    address: { it: ['Via Roma 1', '', '20121 Milano', ''], en: ['Via Roma 1', '', '', ''] },
    vatNumber: 'IT01234567890',
    iban: 'it60 x054 2811 1010 0000 0123 457',
    contacts: { it: '', en: '' },
  }

  it('POSTs the details exactly as given: blank lines kept in order (E5), nothing normalised, base version sent', async () => {
    mockFetch.mockResolvedValue(
      json({ version: 2, created: true, entity: { ...FIXTURE_CH, entity: 'welld_it', version: 2 } }, 201),
    )
    await saveLegalEntity('welld_it', { baseVersion: 1, details })
    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH}/legal-entities/welld_it/versions`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ baseVersion: 1, details })
    expect((JSON.parse(init.body as string) as { details: LegalEntityDetails }).details.address.it).toEqual([
      'Via Roma 1',
      '',
      '20121 Milano',
      '',
    ])
  })

  it('sends only the five members of `details`, whatever else the caller’s object carries', async () => {
    mockFetch.mockResolvedValue(json({ version: 4, created: true, entity: FIXTURE_CH }, 201))
    await saveLegalEntity('welld_ch', {
      baseVersion: 3,
      details: { ...details, ...FIXTURE_CH } as unknown as LegalEntityDetails,
    })
    const sent = JSON.parse(lastCall().init.body as string) as { details: Record<string, unknown> }
    expect(Object.keys(sent.details).sort()).toEqual(['address', 'contacts', 'iban', 'legalName', 'vatNumber'])
  })

  it('201: the new version and the normalised entity to reload the form from', async () => {
    mockFetch.mockResolvedValue(json({ version: 4, created: true, entity: FIXTURE_CH }, 201))
    const result = await saveLegalEntity('welld_ch', { baseVersion: 3, details })
    expect(result).toEqual({ version: 4, created: true, entity: FIXTURE_CH })
  })

  it('200 `created: false`: the no-op answer (AC-2.1)', async () => {
    mockFetch.mockResolvedValue(json({ version: 3, created: false, entity: FIXTURE_CH }, 200))
    const result = await saveLegalEntity('welld_ch', { baseVersion: 3, details })
    expect(result.created).toBe(false)
    expect(result.version).toBe(3)
  })

  it('an answer without the entity is a contract failure (the form could not reload)', async () => {
    mockFetch.mockResolvedValue(json({ version: 4, created: true }, 201))
    await expect(saveLegalEntity('welld_ch', { baseVersion: 3, details })).rejects.toBeInstanceOf(
      LegalEntityContractError,
    )
  })

  it('422 invalid_legal_entity: every problem at once, typed, with its line (E5)', async () => {
    const problems = [
      { field: 'vatNumber', reason: 'required' },
      { field: 'address.it', line: 2, reason: 'too_long', limit: 120 },
      { field: 'address.en', reason: 'required' },
      { field: 'address.it', reason: 'too_many_lines', limit: 4 },
    ]
    mockFetch.mockResolvedValue(problemJson(422, { code: 'invalid_legal_entity', problems }))
    const error = await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LegalEntityApiError)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 422, code: 'invalid_legal_entity', problems })
  })

  it('422 whose problems this build cannot read in full keeps none (a partial list would under-count)', async () => {
    mockFetch.mockResolvedValue(
      problemJson(422, {
        code: 'invalid_legal_entity',
        problems: [
          { field: 'iban', reason: 'iban_format' },
          { field: 'iban', reason: 'new' },
        ],
      }),
    )
    const error = (await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch(
      (e: unknown) => e,
    )) as LegalEntityApiError
    expect(error.status).toBe(422)
    expect(error.problems).toBeUndefined()
  })

  it('problems on any other code are not read (a 422 `invalid_request` has no list)', async () => {
    mockFetch.mockResolvedValue(
      problemJson(422, { code: 'invalid_request', problems: [{ field: 'iban', reason: 'iban_format' }] }),
    )
    const error = (await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch(
      (e: unknown) => e,
    )) as LegalEntityApiError
    expect(error.problems).toBeUndefined()
  })

  it('409 version_conflict carries the current version (AC-2.6)', async () => {
    mockFetch.mockResolvedValue(problemJson(409, { code: 'version_conflict', currentVersion: 5 }))
    const error = await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 409, code: 'version_conflict', currentVersion: 5 })
  })

  it('409 legal_entity_not_moved, 403 forbidden: status and code, no extras', async () => {
    mockFetch.mockResolvedValueOnce(problemJson(409, { code: 'legal_entity_not_moved' }))
    await expect(saveLegalEntity('welld_ch', { baseVersion: 0, details })).rejects.toMatchObject({
      status: 409,
      code: 'legal_entity_not_moved',
      currentVersion: undefined,
    })
    mockFetch.mockResolvedValueOnce(problemJson(403, { code: 'forbidden' }))
    await expect(saveLegalEntity('welld_ch', { baseVersion: 3, details })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
  })

  it('a non-integer currentVersion is ignored', async () => {
    mockFetch.mockResolvedValue(problemJson(409, { code: 'version_conflict', currentVersion: '5' }))
    const error = (await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch(
      (e: unknown) => e,
    )) as LegalEntityApiError
    expect(error.currentVersion).toBeUndefined()
  })

  it('a 5xx with a body that is not a problem still gives an error with its status', async () => {
    mockFetch.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
    const error = (await saveLegalEntity('welld_ch', { baseVersion: 3, details }).catch(
      (e: unknown) => e,
    )) as LegalEntityApiError
    expect(error).toBeInstanceOf(LegalEntityApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBeUndefined()
    expect(error.title).toBe('Bad Gateway')
  })

  it('a network failure is not swallowed or retyped', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(saveLegalEntity('welld_ch', { baseVersion: 3, details })).rejects.toThrow('Failed to fetch')
  })
})

describe('restoreVersion (AC-2.4)', () => {
  it('POSTs the base version to the version’s restore route and parses a save result', async () => {
    mockFetch.mockResolvedValue(json({ version: 5, created: true, entity: FIXTURE_CH }, 201))
    const result = await restoreVersion('welld_ch', 2, 4)
    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH}/legal-entities/welld_ch/versions/2/restore`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ baseVersion: 4 })
    expect(result.version).toBe(5)
  })

  it('422 for a version today’s rules refuse carries its problems', async () => {
    mockFetch.mockResolvedValue(
      problemJson(422, { code: 'invalid_legal_entity', problems: [{ field: 'vatNumber', reason: 'required' }] }),
    )
    await expect(restoreVersion('welld_it', 1, 1)).rejects.toMatchObject({
      status: 422,
      problems: [{ field: 'vatNumber', reason: 'required' }],
    })
  })
})

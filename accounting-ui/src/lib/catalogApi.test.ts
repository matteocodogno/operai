import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, problem } from '../test-support/fakeApi'
import { ApiError } from './api'
import {
  createLedgerAccount,
  deactivateLedgerAccount,
  duplicateIsDeactivated,
  listLedgerAccounts,
  reactivateLedgerAccount,
  refusedFields,
} from './catalogApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

afterEach(() => vi.clearAllMocks())

const urlOf = (call: number) => String(apiFetch.mock.calls[call]![0])

describe('catalogApi: ledger accounts (T29, plan § API contracts)', () => {
  it('lists under /v1/entities/{entity}/ledger-accounts and unwraps { entity, items }, with no id anywhere', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_it/ledger-accounts': () => ({
          status: 200,
          body: { entity: 'welld_it', items: [{ number: '1000', name: 'Cassa', active: true }] },
        }),
      }),
    )
    const items = await listLedgerAccounts('welld_it')
    expect(urlOf(0)).toBe('http://accounting-api.test/v1/entities/welld_it/ledger-accounts')
    expect(items).toEqual([{ number: '1000', name: 'Cassa', active: true }])
  })

  it('reads a body without a list as empty, and drops what it cannot vouch for', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_ch/ledger-accounts': () => ({
          status: 200,
          body: { items: [null, 'x', { name: 'no number' }, { number: 5905, name: 'n' }, { number: '5906', name: 'ok', active: 'yes' }] },
        }),
      }),
    )
    // `active` must be the literal true: anything else reads as deactivated (never offers a deactivated row as usable).
    expect(await listLedgerAccounts('welld_ch')).toEqual([{ number: '5906', name: 'ok', active: false }])

    apiFetch.mockImplementation(fakeApi({ 'GET /v1/entities/welld_ch/ledger-accounts': () => ({ status: 200, body: {} }) }))
    expect(await listLedgerAccounts('welld_ch')).toEqual([])
  })

  it('creates with POST { number, name } and returns the row', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/ledger-accounts': () => ({
          status: 201,
          body: { number: '2620.1', name: 'Anticipi', active: true },
        }),
      }),
    )
    expect(await createLedgerAccount('welld_ch', { number: '2620.1', name: 'Anticipi' })).toEqual({
      number: '2620.1',
      name: 'Anticipi',
      active: true,
    })
    const init = apiFetch.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ number: '2620.1', name: 'Anticipi' })
  })

  it('an answer that is not a row is a failure of the call, not an empty row', async () => {
    apiFetch.mockImplementation(fakeApi({ 'POST /v1/entities/welld_ch/ledger-accounts': () => ({ status: 201, body: {} }) }))
    await expect(createLedgerAccount('welld_ch', { number: '1', name: 'x' })).rejects.toBeInstanceOf(TypeError)
  })

  it('deactivates and reactivates by the natural key, encoded, with no body', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/ledger-accounts/2620.1/deactivate': () => ({
          status: 200,
          body: { number: '2620.1', name: 'A', active: false },
        }),
        'POST /v1/entities/welld_ch/ledger-accounts/2620.1/reactivate': () => ({
          status: 200,
          body: { number: '2620.1', name: 'A', active: true },
        }),
      }),
    )
    expect((await deactivateLedgerAccount('welld_ch', '2620.1')).active).toBe(false)
    expect((await reactivateLedgerAccount('welld_ch', '2620.1')).active).toBe(true)
    expect((apiFetch.mock.calls[0]![1] as RequestInit).body).toBeUndefined()
  })

  it('encodes a key that is not path-safe (a value never splits the path)', async () => {
    apiFetch.mockImplementation(fakeApi({}))
    await deactivateLedgerAccount('welld_ch', '../x/y?z').catch(() => undefined)
    expect(urlOf(0)).toBe('http://accounting-api.test/v1/entities/welld_ch/ledger-accounts/..%2Fx%2Fy%3Fz/deactivate')
  })

  it('a failure is an ApiError whose code and extras the caller branches on', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/ledger-accounts': () =>
          problem(409, 'ledger_account_duplicate', { number: '5905', reactivate: true }),
      }),
    )
    const error = await createLedgerAccount('welld_ch', { number: '5905', name: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('ledger_account_duplicate')
    expect(duplicateIsDeactivated(error as ApiError)).toBe(true)
  })
})

describe('catalogApi: reading a refusal', () => {
  const error = (extras: Record<string, unknown>) => new ApiError({ status: 422, title: 'x', extras })

  it('reads fields[] with a guard and maps an unknown reason to format', () => {
    expect(
      refusedFields(
        error({ fields: [{ field: 'number', reason: 'too_long' }, { field: 'name', reason: 'brand_new' }, { reason: 'empty' }, 7] }),
      ),
    ).toEqual([
      { field: 'number', reason: 'too_long' },
      { field: 'name', reason: 'format' },
    ])
    expect(refusedFields(error({}))).toEqual([])
    expect(refusedFields(error({ fields: 'nope' }))).toEqual([])
  })

  it('duplicateIsDeactivated is the flag when it is a boolean, else null (use the list)', () => {
    expect(duplicateIsDeactivated(error({ reactivate: false }))).toBe(false)
    expect(duplicateIsDeactivated(error({ reactivate: true }))).toBe(true)
    expect(duplicateIsDeactivated(error({ reactivate: 'true' }))).toBeNull()
    expect(duplicateIsDeactivated(error({}))).toBeNull()
  })
})

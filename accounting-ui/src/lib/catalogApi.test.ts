import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, problem } from '../test-support/fakeApi'
import { ApiError } from './api'
import {
  catalogFullLimit,
  createLedgerAccount,
  createVatCode,
  deactivateLedgerAccount,
  deactivateVatCode,
  duplicateIsDeactivated,
  listLedgerAccounts,
  listVatCodes,
  reactivateLedgerAccount,
  reactivateVatCode,
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

describe('catalogApi: VAT codes (T30, plan § API contracts)', () => {
  it('lists under /v1/entities/{entity}/vat-codes, unwraps { entity, items } and keeps the rate as the server’s string', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_it/vat-codes': () => ({
          status: 200,
          body: {
            entity: 'welld_it',
            items: [
              { code: 'IVA22', label: 'IVA 22%', ratePercent: '22', rateBasisPoints: 2200, active: true },
              { code: 'BAD', label: 'no rate' },
              { label: 'no code', ratePercent: '1' },
            ],
          },
        }),
      }),
    )
    expect(await listVatCodes('welld_it')).toEqual([{ code: 'IVA22', label: 'IVA 22%', ratePercent: '22', active: true }])
    expect(urlOf(0)).toBe('http://accounting-api.test/v1/entities/welld_it/vat-codes')
  })

  it('creates with POST { code, label, ratePercent } and returns the row; an answer that is not a row fails', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/vat-codes': () => ({
          status: 201,
          body: { code: 'IMP81', label: 'Imposta', ratePercent: '8.1', rateBasisPoints: 810, active: true },
        }),
      }),
    )
    expect(await createVatCode('welld_ch', { code: 'IMP81', label: 'Imposta', ratePercent: '8.1' })).toEqual({
      code: 'IMP81',
      label: 'Imposta',
      ratePercent: '8.1',
      active: true,
    })
    expect(JSON.parse(String((apiFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      code: 'IMP81',
      label: 'Imposta',
      ratePercent: '8.1',
    })
    apiFetch.mockImplementation(fakeApi({ 'POST /v1/entities/welld_ch/vat-codes': () => ({ status: 201, body: { code: 'X' } }) }))
    await expect(createVatCode('welld_ch', { code: 'X', label: 'x', ratePercent: '1' })).rejects.toBeInstanceOf(TypeError)
  })

  it('deactivates and reactivates by the code, encoded, with no body; it has no way to send a rate change', async () => {
    const row = { code: 'A-1_B', label: 'x', ratePercent: '1', rateBasisPoints: 100 }
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/vat-codes/A-1_B/deactivate': () => ({ status: 200, body: { ...row, active: false } }),
        'POST /v1/entities/welld_ch/vat-codes/A-1_B/reactivate': () => ({ status: 200, body: { ...row, active: true } }),
      }),
    )
    expect((await deactivateVatCode('welld_ch', 'A-1_B')).active).toBe(false)
    expect((await reactivateVatCode('welld_ch', 'A-1_B')).active).toBe(true)
    expect((apiFetch.mock.calls[0]![1] as RequestInit).body).toBeUndefined()
  })

  it('a 409 duplicate carries the code and the reactivate flag in its extras', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/vat-codes': () => problem(409, 'vat_code_duplicate', { vatCode: 'IMP81', reactivate: false }),
      }),
    )
    const error = (await createVatCode('welld_ch', { code: 'imp81', label: 'x', ratePercent: '1' }).catch((e: unknown) => e)) as ApiError
    expect(error.code).toBe('vat_code_duplicate')
    expect(error.extras.vatCode).toBe('IMP81')
    expect(duplicateIsDeactivated(error)).toBe(false)
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

describe('catalogFullLimit (T53: 409 catalog_full carries `limit`)', () => {
  const full = (extras: Record<string, unknown>) =>
    new ApiError({ status: 409, title: 'Conflict', code: 'catalog_full', extras })

  it('is the server’s limit when it is a whole number above 0', () => {
    expect(catalogFullLimit(full({ limit: 200 }), 7)).toBe(200)
    expect(catalogFullLimit(full({ limit: 50 }), 7)).toBe(50)
    expect(catalogFullLimit(full({ limit: 1 }), 7)).toBe(1)
  })

  it.each([undefined, null, 0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '200', [200], { limit: 200 }, 2 ** 60])(
    'is the fallback for an unreadable limit %j (a sentence never says "undefined" or 0)',
    (limit) => {
      expect(catalogFullLimit(full({ limit }), 7)).toBe(7)
    },
  )

  it('is the fallback when the body has no extras at all', () => {
    expect(catalogFullLimit(new ApiError({ status: 409, title: 'Conflict', code: 'catalog_full' }), 7)).toBe(7)
  })
})

/**
 * @vitest-environment jsdom
 *
 * accountingApi (T21, specs/20261118-refund-accounting-export): every URL, method and body of plan.md § API contracts,
 * error `code` passthrough, and the guard on the `classification_missing` body.
 * `shell/session`'s `apiFetch` is mocked, as in the other API module tests: the backend is built elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import {
  classificationMissingLines,
  classifyLine,
  getAccountingOptions,
  getExpenseTypeDefaults,
  getRequestAccounting,
  putExpenseTypeDefault,
  putForeignCurrencyVatCode,
  entryIsUnusable,
  isAccountingUnavailable,
} from './accountingApi'
import { ApiError } from './refundApi'

const BASE = 'http://refund-api.test'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const lastCall = () => {
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', BASE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('defaults (specs/20261119-accounting: by number and code, with states)', () => {
  it('GETs the defaults, and says Accounting was readable when the answer does not say otherwise', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { entity: 'welld_ch', types: [] }))
    await expect(getExpenseTypeDefaults()).resolves.toMatchObject({ accounting: 'available' })
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/expense-type-defaults`, method: 'GET' })
  })

  it('reads accounting: "unavailable" as sent, whatever else it holds', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { entity: 'welld_ch', accounting: 'unavailable', types: [] }))
    await expect(getExpenseTypeDefaults()).resolves.toMatchObject({ accounting: 'unavailable' })
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { entity: 'welld_ch', accounting: 'weird', types: [] }))
    await expect(getExpenseTypeDefaults()).resolves.toMatchObject({ accounting: 'available' })
  })

  it('PUTs the number and the code, nulls included, to the type', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { type: 'travel_train' }))
    await putExpenseTypeDefault('travel_train', { accountNumber: '5901', vatCode: null })
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/expense-type-defaults/travel_train`,
      method: 'PUT',
      body: { accountNumber: '5901', vatCode: null },
    })
  })

  it.each([
    [422, 'ledger_account_inactive'],
    [422, 'ledger_account_not_found'],
    [422, 'vat_code_inactive'],
    [422, 'vat_code_not_found'],
    [503, 'accounting_unavailable'],
  ])('passes %i %s through', async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(status, { title: 'x', status, code }))
    await expect(
      putExpenseTypeDefault('travel_train', { accountNumber: '5901', vatCode: null }),
    ).rejects.toMatchObject({ status, code })
  })

  it('PUTs the foreign-currency VAT code by code, null clearing it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { foreignCurrencyVatCode: null }))
    await putForeignCurrencyVatCode(null)
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/foreign-currency-vat-code`,
      method: 'PUT',
      body: { vatCode: null },
    })
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { foreignCurrencyVatCode: null }))
    await putForeignCurrencyVatCode('IMP81')
    expect(lastCall().body).toEqual({ vatCode: 'IMP81' })
  })

  it('knows a 503 accounting_unavailable from any other failure, and which states are unusable', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(503, { title: 'x', status: 503, code: 'accounting_unavailable' }))
    const unavailable = await getAccountingOptions().catch((caught: unknown) => caught)
    expect(isAccountingUnavailable(unavailable)).toBe(true)
    vi.mocked(apiFetch).mockResolvedValueOnce(json(503, { title: 'x', status: 503, code: 'authz_unavailable' }))
    expect(isAccountingUnavailable(await getAccountingOptions().catch((caught: unknown) => caught))).toBe(false)
    expect(isAccountingUnavailable(new Error('x'))).toBe(false)

    expect(entryIsUnusable('deactivated')).toBe(true)
    expect(entryIsUnusable('not_found')).toBe(true)
    expect(entryIsUnusable('active')).toBe(false)
    expect(entryIsUnusable('unverified')).toBe(false)
  })
})

describe('classification', () => {
  it('reads the availability and the rates link flag of the review view, failing closed when they are absent', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(200, { requestId: 'r1', accounting: 'unavailable', viewer: { canOpenAccountingRates: true }, lines: [] }),
    )
    await expect(getRequestAccounting('r1')).resolves.toMatchObject({
      accounting: 'unavailable',
      viewer: { canOpenAccountingRates: true },
    })
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { requestId: 'r1', lines: [] }))
    await expect(getRequestAccounting('r1')).resolves.toMatchObject({
      accounting: 'available',
      viewer: { canOpenAccountingRates: false },
    })
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(200, { requestId: 'r1', viewer: { canOpenAccountingRates: 'yes' }, lines: [] }),
    )
    await expect(getRequestAccounting('r1')).resolves.toMatchObject({ viewer: { canOpenAccountingRates: false } })
  })

  it('GETs the options and the accounting view of a request', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { ledgerAccounts: [], vatCodes: [] }))
    await getAccountingOptions()
    expect(lastCall().url).toBe(`${BASE}/accounting/options`)

    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { requestId: 'r1', lines: [] }))
    await getRequestAccounting('r1')
    expect(lastCall()).toMatchObject({ url: `${BASE}/review/requests/r1/accounting`, method: 'GET' })
  })

  it('PUTs only the key that changed and returns the line as sent', async () => {
    const line = { lineId: 'l1', vatAmountCents: 156 }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, line))
    await expect(classifyLine('r1', 'l1', { accountNumber: '5905' })).resolves.toEqual({ ...line, inScope: true })
    expect(lastCall()).toEqual({
      url: `${BASE}/review/requests/r1/lines/l1/classification`,
      method: 'PUT',
      body: { accountNumber: '5905' },
    })
  })

  it.each(['classification_locked', 'not_classifiable_status', 'line_rejected'])(
    'passes the 409 %s through',
    async (code) => {
      vi.mocked(apiFetch).mockResolvedValueOnce(json(409, { title: 'Conflict', status: 409, code }))
      await expect(classifyLine('r1', 'l1', { vatCode: 'NOVAT' })).rejects.toMatchObject({ status: 409, code })
    },
  )
})

describe('the accounting view: entity scope and segregation of duties (plan.md SR-1, SR-2)', () => {
  const inScopeLine = {
    lineId: 'l1',
    inScope: true,
    classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
    chf: { amountCents: 100, rateMicros: null, rate: null, rateMonth: null, rateStatus: 'not_applicable' },
    vatAmountCents: 8,
  }

  it('reads inScope and selfRestricted as sent', async () => {
    const outOfScope = { lineId: 'l2', inScope: false, classification: null, chf: null, vatAmountCents: null }
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(200, { requestId: 'r1', selfRestricted: true, lines: [inScopeLine, outOfScope] }),
    )
    const view = await getRequestAccounting('r1')
    expect(view.selfRestricted).toBe(true)
    expect(view.lines).toEqual([inScopeLine, outOfScope])
  })

  it('a body without the flags reads as in scope and not self-restricted (a backend a step behind)', async () => {
    const legacy: Record<string, unknown> = { ...inScopeLine }
    delete legacy.inScope
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { requestId: 'r1', lines: [legacy] }))
    const view = await getRequestAccounting('r1')
    expect(view.selfRestricted).toBe(false)
    expect(view.lines[0].inScope).toBe(true)
  })

  it('strips any accounting data a server sent for an out-of-scope line, in the view and in a PUT answer', async () => {
    const leaky = { ...inScopeLine, inScope: false }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { requestId: 'r1', selfRestricted: false, lines: [leaky] }))
    expect((await getRequestAccounting('r1')).lines[0]).toMatchObject({
      inScope: false,
      classification: null,
      chf: null,
      vatAmountCents: null,
    })
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, leaky))
    await expect(classifyLine('r1', 'l1', { vatCode: 'NOVAT' })).resolves.toMatchObject({
      inScope: false,
      classification: null,
      chf: null,
      vatAmountCents: null,
    })
  })

  it.each([
    ['PUT', 403, 'self_approval_forbidden'],
    ['PUT', 404, 'not_found'],
    ['GET options', 403, 'accounting_out_of_scope'],
  ])('passes %s %i %s through as an ApiError', async (which, status, code) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(status, { title: 'x', status, code }))
    const call = which === 'PUT' ? classifyLine('r1', 'l1', { vatCode: 'NOVAT' }) : getAccountingOptions()
    await expect(call).rejects.toMatchObject({ status, code })
  })
})

describe('classificationMissingLines', () => {
  const refusal = (extra: Record<string, unknown>) =>
    new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'classification_missing' }, extra)

  it('reads the lines of a classification_missing refusal', () => {
    const lines = [
      { lineId: 'l1', date: '2026-03-19', type: 'travel_train', missing: ['account', 'vatCode'] },
      { lineId: 'l2', date: '2026-03-20', type: 'postal', missing: ['vatCode'] },
    ]
    expect(classificationMissingLines(refusal({ lines }))).toEqual(lines)
  })

  it('drops malformed entries and unknown missing values instead of crashing', () => {
    const result = classificationMissingLines(
      refusal({
        lines: [
          null,
          'x',
          { lineId: 'l1' },
          { lineId: 'l2', date: '2026-03-20', type: 'postal', missing: ['account', 'tax', 7] },
          { lineId: 'l3', date: '2026-03-21', type: 'postal', missing: 'account' },
        ],
      }),
    )
    expect(result).toEqual([
      { lineId: 'l2', date: '2026-03-20', type: 'postal', missing: ['account'] },
      { lineId: 'l3', date: '2026-03-21', type: 'postal', missing: [] },
    ])
  })

  it('is an empty list when the refusal carries no lines, and null for any other error', () => {
    expect(classificationMissingLines(refusal({}))).toEqual([])
    expect(classificationMissingLines(refusal({ lines: 'nope' }))).toEqual([])
    expect(
      classificationMissingLines(
        new ApiError({ type: 't', title: 'c', status: 409, code: 'accounting_release_pending' }),
      ),
    ).toBeNull()
    expect(classificationMissingLines(new ApiError({ type: 't', title: 'c', status: 409 }))).toBeNull()
    expect(classificationMissingLines(new Error('boom'))).toBeNull()
    expect(classificationMissingLines(undefined)).toBeNull()
  })

  it('reads the refusal end to end from a 409 response', async () => {
    const lines = [{ lineId: 'l1', date: '2026-03-19', type: 'travel_train', missing: ['account'] }]
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, { title: 'Conflict', status: 409, code: 'classification_missing', lines }),
    )
    const { approve } = await import('./reviewApi')
    const error = await approve('r1').catch((caught: unknown) => caught)
    expect(classificationMissingLines(error)).toEqual(lines)
  })
})

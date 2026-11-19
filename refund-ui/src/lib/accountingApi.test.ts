/**
 * @vitest-environment jsdom
 *
 * accountingApi (T21, specs/20261118-refund-accounting-export): every URL, method and body of plan.md § API contracts,
 * the `{ items }` unwrapping, error `code` passthrough, and the guard on the `classification_missing` body.
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
  createLedgerAccount,
  createVatCode,
  deactivateLedgerAccount,
  deactivateVatCode,
  getAccountingOptions,
  getExpenseTypeDefaults,
  getRequestAccounting,
  listLedgerAccounts,
  listVatCodes,
  putExpenseTypeDefault,
  putForeignCurrencyVatCode,
  reactivateLedgerAccount,
  reactivateVatCode,
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

describe('ledger accounts', () => {
  it('lists the items of the envelope', async () => {
    const account = { id: 'a1', number: '5905', name: 'Spese', active: true, history: [] }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { items: [account] }))
    await expect(listLedgerAccounts()).resolves.toEqual([account])
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/ledger-accounts`, method: 'GET' })
  })

  it('POSTs number and name', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(201, { id: 'a1', number: '5905' }))
    await createLedgerAccount({ number: '5905', name: 'Spese rimborsi' })
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/ledger-accounts`,
      method: 'POST',
      body: { number: '5905', name: 'Spese rimborsi' },
    })
  })

  it('POSTs deactivate and reactivate to the account, with the id encoded', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { id: 'a/1' }))
    await deactivateLedgerAccount('a/1')
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/ledger-accounts/a%2F1/deactivate`, method: 'POST' })

    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { id: 'a1' }))
    await reactivateLedgerAccount('a1')
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/ledger-accounts/a1/reactivate`, method: 'POST' })
  })

  it.each([
    [409, 'ledger_account_duplicate', 'Account 5905 already exists'],
    [422, 'invalid_ledger_account', 'bad number'],
    [409, 'already_active', 'Account 5905 is already active'],
  ])('passes the %i problem code %s through', async (status, code, detail) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(status, { title: 'x', status, code, detail }))
    const error = await createLedgerAccount({ number: '5905', name: 'x' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code, detail })
  })

  it('throws a 403 for a caller without settings:read', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(403, { title: 'Forbidden', status: 403 }))
    await expect(listLedgerAccounts()).rejects.toMatchObject({ status: 403, code: undefined })
  })
})

describe('VAT codes', () => {
  it('lists the items and POSTs code, label and ratePercent as a string', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { items: [{ id: 'v1', code: 'IMP81', ratePercent: '8.1' }] }))
    await expect(listVatCodes()).resolves.toHaveLength(1)
    expect(lastCall().url).toBe(`${BASE}/accounting/vat-codes`)

    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(201, { id: 'v1' }))
    await createVatCode({ code: 'IMP81', label: 'Impôt 8.1%', ratePercent: '8.1' })
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/vat-codes`,
      method: 'POST',
      body: { code: 'IMP81', label: 'Impôt 8.1%', ratePercent: '8.1' },
    })
  })

  it('POSTs deactivate and reactivate', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { id: 'v1' }))
    await deactivateVatCode('v1')
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/vat-codes/v1/deactivate`, method: 'POST' })

    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { id: 'v1' }))
    await reactivateVatCode('v1')
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/vat-codes/v1/reactivate`, method: 'POST' })
  })

  it('passes vat_code_duplicate through', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, {
        title: 'Conflict',
        status: 409,
        code: 'vat_code_duplicate',
        detail: 'VAT code IMP81 already exists',
      }),
    )
    await expect(createVatCode({ code: 'IMP81', label: 'x', ratePercent: '8.1' })).rejects.toMatchObject({
      code: 'vat_code_duplicate',
    })
  })

  it('has no update operation: the module exports no put/patch for a ledger account or a VAT code (AC-1.5)', async () => {
    const module = await import('./accountingApi')
    expect(Object.keys(module).filter((name) => /^(update|edit|patch|put)(Ledger|Vat)/i.test(name))).toEqual([])
  })
})

describe('defaults', () => {
  it('GETs the defaults', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { entity: 'welld_ch', types: [] }))
    await getExpenseTypeDefaults()
    expect(lastCall()).toMatchObject({ url: `${BASE}/accounting/expense-type-defaults`, method: 'GET' })
  })

  it('PUTs both ids, nulls included, to the type', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { type: 'travel_train' }))
    await putExpenseTypeDefault('travel_train', { ledgerAccountId: 'a1', vatCodeId: null })
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/expense-type-defaults/travel_train`,
      method: 'PUT',
      body: { ledgerAccountId: 'a1', vatCodeId: null },
    })
  })

  it('passes a 422 inactive code through', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(422, { title: 'Unprocessable', status: 422, code: 'ledger_account_inactive' }),
    )
    await expect(
      putExpenseTypeDefault('travel_train', { ledgerAccountId: 'a1', vatCodeId: null }),
    ).rejects.toMatchObject({ status: 422, code: 'ledger_account_inactive' })
  })

  it('PUTs the foreign-currency VAT code, null clearing it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { foreignCurrencyVatCode: null }))
    await putForeignCurrencyVatCode(null)
    expect(lastCall()).toEqual({
      url: `${BASE}/accounting/foreign-currency-vat-code`,
      method: 'PUT',
      body: { vatCodeId: null },
    })
  })
})

describe('classification', () => {
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
    await expect(classifyLine('r1', 'l1', { ledgerAccountId: 'a2' })).resolves.toEqual({ ...line, inScope: true })
    expect(lastCall()).toEqual({
      url: `${BASE}/review/requests/r1/lines/l1/classification`,
      method: 'PUT',
      body: { ledgerAccountId: 'a2' },
    })
  })

  it.each(['classification_locked', 'not_classifiable_status', 'line_rejected'])(
    'passes the 409 %s through',
    async (code) => {
      vi.mocked(apiFetch).mockResolvedValueOnce(json(409, { title: 'Conflict', status: 409, code }))
      await expect(classifyLine('r1', 'l1', { vatCodeId: 'v1' })).rejects.toMatchObject({ status: 409, code })
    },
  )
})

describe('the accounting view: entity scope and segregation of duties (plan.md SR-1, SR-2)', () => {
  const inScopeLine = {
    lineId: 'l1',
    inScope: true,
    classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
    chf: { amountCents: 100, rateMicros: null, rate: null, rateMonth: null, rateMissing: false },
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
    await expect(classifyLine('r1', 'l1', { vatCodeId: 'v1' })).resolves.toMatchObject({
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
    const call = which === 'PUT' ? classifyLine('r1', 'l1', { vatCodeId: 'v1' }) : getAccountingOptions()
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

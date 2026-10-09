import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './api'
import { toInventoryError, validationField } from './types'

const BASE = 'http://inventory-api.test'

const ok = (status: number, body?: unknown): Response =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const problem = (status: number, body: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ title: 'Problem', status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

/** The method, URL and parsed JSON body of the single request a call made. */
const lastRequest = () => {
  const [url, init] = vi.mocked(apiFetch).mock.calls.at(-1) as [string, RequestInit | undefined]
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    rawBody: init?.body,
  }
}

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to reject')
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
import {
  finishRepair,
  getAsset,
  listAssets,
  markFound,
  markLost,
  receiveAsset,
  registerAssets,
  returnAsset,
  startRepair,
  updateAsset,
} from './assetsApi'

const asset = { id: 'a-1', entity: 'welld_ch', status: 'in_stock' }

describe('assetsApi — reads', () => {
  it('GET /assets with no filters sends no query string', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { items: [], nextCursor: null }))

    await expect(listAssets()).resolves.toEqual({ items: [], nextCursor: null })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets`, method: 'GET' })
  })

  it('serialises every filter, in a fixed order, skipping unset and empty ones', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { items: [], nextCursor: null }))

    await listAssets({
      entity: 'welld_ch',
      status: 'assigned',
      category: 'laptop',
      holderUserId: 'u1',
      toVerify: true,
      invoiceRef: 'INV 7/26',
      q: 'mac book',
      cursor: 'c1',
      limit: 50,
    })

    expect(lastRequest().url).toBe(
      `${BASE}/assets?entity=welld_ch&status=assigned&category=laptop&holderUserId=u1&toVerify=true&invoiceRef=INV+7%2F26&q=mac+book&cursor=c1&limit=50`,
    )
  })

  it('omits toVerify when false or undefined and drops an empty search text', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { items: [], nextCursor: null }))

    await listAssets({ toVerify: false, q: '', invoiceRef: undefined })

    expect(lastRequest().url).toBe(`${BASE}/assets`)
  })

  it('returns the cursor for the next page', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { items: [asset], nextCursor: 'next-1' }))

    expect((await listAssets({ limit: 1 })).nextCursor).toBe('next-1')
  })

  it('403 (neither capability) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(403))

    expect((await rejection(listAssets())).status).toBe(403)
  })

  it('GET /assets/{id} returns the asset view', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, asset))

    await expect(getAsset('a-1')).resolves.toEqual(asset)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets/a-1`, method: 'GET' })
  })

  it('GET /assets/{id} encodes the id and maps 404 to a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(404))

    const error = await rejection(getAsset('a/b'))

    expect(lastRequest().url).toBe(`${BASE}/assets/a%2Fb`)
    expect(error.status).toBe(404)
  })
})

describe('assetsApi — register', () => {
  const input = {
    entity: 'welld_ch' as const,
    category: 'laptop' as const,
    description: 'MacBook Pro 14',
    purchaseDate: '2026-09-30',
    totalPriceCents: 480000,
    quantity: 2,
    serialNumbers: ['S1', 'S2'],
    received: false,
    supplier: 'Apple',
    invoiceRef: 'INV-1',
    locationNote: 'Rack 3',
  }

  it('POST /assets sends the body unchanged and returns the created assets', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(201, { assets: [asset] }))

    await expect(registerAssets(input)).resolves.toEqual({ assets: [asset] })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets`, method: 'POST', body: input })
  })

  it('422 serial_count_mismatch maps to the known error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(422, { code: 'serial_count_mismatch' }))

    expect(toInventoryError(await rejection(registerAssets(input)))).toMatchObject({
      code: 'serial_count_mismatch',
      status: 422,
    })
  })

  it('409 serial_conflict carries the serial number and the conflicting asset id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'serial_conflict', serialNumber: 'S1', assetId: 'a-9' }))

    expect(toInventoryError(await rejection(registerAssets(input)))).toMatchObject({
      code: 'serial_conflict',
      status: 409,
      extras: { serialNumber: 'S1', assetId: 'a-9' },
    })
  })

  it('409 fiscal_year_closed carries the year as a number', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'fiscal_year_closed', year: 2025 }))

    expect(toInventoryError(await rejection(registerAssets(input)))).toMatchObject({
      code: 'fiscal_year_closed',
      extras: { year: 2025 },
    })
  })

  it('422 validation exposes the offending field through extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(422, { field: 'totalPriceCents' }))

    const error = await rejection(registerAssets(input))

    expect(error.status).toBe(422)
    expect(error.extras).toEqual({ field: 'totalPriceCents' })
    expect(toInventoryError(error)).toBeNull()
  })
})

describe('assetsApi — edit', () => {
  it('PATCH /assets/{id} sends only the fields given', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, asset))

    await updateAsset('a-1', { supplier: 'Apple', toVerify: false })

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/assets/a-1`,
      method: 'PATCH',
      body: { supplier: 'Apple', toVerify: false },
    })
  })

  it.each([
    ['asset_disposed', 409, { assetId: 'a-1' }, { assetId: 'a-1' }],
    ['fiscal_year_closed', 409, { year: 2024 }, { year: 2024 }],
    ['serial_conflict', 409, { serialNumber: 'S1', assetId: 'a-2' }, { serialNumber: 'S1', assetId: 'a-2' }],
  ])('%s maps to the known error with its extras', async (code, status, wire, extras) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(status, { code, ...wire }))

    expect(toInventoryError(await rejection(updateAsset('a-1', { description: 'x' })))).toMatchObject({
      code,
      status,
      extras,
    })
  })

  it('403 (accountant-only caller patching a non-invoice field) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(403))

    expect((await rejection(updateAsset('a-1', { description: 'x' }))).status).toBe(403)
  })
})

describe('assetsApi — status transitions', () => {
  it.each([
    ['receiveAsset', receiveAsset, 'receive'],
    ['returnAsset', returnAsset, 'return'],
    ['startRepair', startRepair, 'repair'],
    ['finishRepair', finishRepair, 'repair-done'],
    ['markLost', markLost, 'lost'],
    ['markFound', markFound, 'found'],
  ])('%s POSTs /assets/{id}/%s with no body', async (_name, call, segment) => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, asset))

    await expect(call('a-1')).resolves.toEqual(asset)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets/a-1/${segment}`, method: 'POST', rawBody: undefined })
  })

  it('409 invalid_transition carries the current status as "from"', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'invalid_transition', from: 'assigned' }))

    expect(toInventoryError(await rejection(receiveAsset('a-1')))).toMatchObject({
      code: 'invalid_transition',
      status: 409,
      extras: { from: 'assigned' },
    })
  })

  it.each([
    ['markLost', markLost],
    ['startRepair', startRepair],
  ])('%s: 409 assignment_pending maps to the known error', async (_name, call) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'assignment_pending' }))

    expect(toInventoryError(await rejection(call('a-1')))).toMatchObject({ code: 'assignment_pending', status: 409 })
  })

  it('409 asset_disposed maps to the known error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'asset_disposed' }))

    expect(toInventoryError(await rejection(markFound('a-1')))).toMatchObject({ code: 'asset_disposed' })
  })
})

describe('toInventoryError — extras are kept only with their documented type', () => {
  it('accepts a numeric-string year as a number', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'fiscal_year_closed', year: '2025' }))

    expect(toInventoryError(await rejection(registerAssets({} as never)))).toMatchObject({ extras: { year: 2025 } })
  })

  it('drops a wrongly typed or undocumented extra', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      problem(409, { code: 'serial_conflict', serialNumber: 42, assetId: 'a-1', surprise: true }),
    )

    expect(toInventoryError(await rejection(registerAssets({} as never)))?.extras).toEqual({ assetId: 'a-1' })
  })

  it('an unknown code, a missing code and a non-ApiError all map to null', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(409, { code: 'something_new' }))

    expect(toInventoryError(await rejection(registerAssets({} as never)))).toBeNull()
    expect(toInventoryError(new TypeError('Failed to fetch'))).toBeNull()
    expect(toInventoryError(undefined)).toBeNull()
  })
})

describe('validationField', () => {
  it('returns the field of a 422 and nothing for other statuses', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(422, { field: 'purchaseDate' }))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(409, { field: 'purchaseDate' }))

    expect(validationField(await rejection(registerAssets({} as never)))).toBe('purchaseDate')
    expect(validationField(await rejection(registerAssets({} as never)))).toBeUndefined()
    expect(validationField(new Error('x'))).toBeUndefined()
  })
})

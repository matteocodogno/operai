import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import { ApiError } from './api'
import { getMe, readMe } from './meApi'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => apiFetch.mockReset())

describe('getMe', () => {
  it('reads GET /v1/me from the base URL the shell provides, and returns the covered entities', async () => {
    apiFetch.mockResolvedValue(
      json(200, {
        entities: [
          { entity: 'welld_ch', ownCurrency: 'CHF', canManage: true, rateSource: 'bazg' },
          { entity: 'welld_it', ownCurrency: 'EUR', canManage: false, rateSource: null },
        ],
      }),
    )
    await expect(getMe()).resolves.toEqual({
      entities: [
        { entity: 'welld_ch', ownCurrency: 'CHF', canManage: true, rateSource: 'bazg' },
        { entity: 'welld_it', ownCurrency: 'EUR', canManage: false, rateSource: null },
      ],
    })
    expect(apiFetch).toHaveBeenCalledWith('http://accounting-api.test/v1/me', undefined)
  })

  it('throws an ApiError with the code on a 403 accounting_forbidden', async () => {
    apiFetch.mockResolvedValue(json(403, { status: 403, title: 'Forbidden', code: 'accounting_forbidden' }))
    const error = await getMe().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 403, code: 'accounting_forbidden' })
  })
})

describe('readMe (defensive)', () => {
  it('puts WellD CH first whatever the order sent, and drops a duplicate', () => {
    const me = readMe({
      entities: [
        { entity: 'welld_it', ownCurrency: 'EUR', canManage: true, rateSource: null },
        { entity: 'welld_ch', ownCurrency: 'CHF', canManage: false, rateSource: 'bazg' },
        { entity: 'welld_ch', ownCurrency: 'CHF', canManage: true, rateSource: 'bazg' },
      ],
    })
    expect(me.entities.map((e) => e.entity)).toEqual(['welld_ch', 'welld_it'])
    expect(me.entities[0]?.canManage).toBe(false)
  })

  it('drops an entity this build does not know and reads a body without a list as no entity', () => {
    expect(
      readMe({ entities: [{ entity: 'welld_xx', ownCurrency: 'XXX', canManage: true, rateSource: null }] }),
    ).toEqual({
      entities: [],
    })
    expect(readMe({})).toEqual({ entities: [] })
    expect(readMe(null)).toEqual({ entities: [] })
    expect(readMe({ entities: 'welld_ch' })).toEqual({ entities: [] })
  })

  it('fails closed: only a literal true is canManage, and only "bazg" is a source', () => {
    const [entity] = readMe({
      entities: [{ entity: 'welld_ch', ownCurrency: 'CHF', canManage: 'true', rateSource: 'other' }],
    }).entities
    expect(entity).toEqual({ entity: 'welld_ch', ownCurrency: 'CHF', canManage: false, rateSource: null })
  })
})

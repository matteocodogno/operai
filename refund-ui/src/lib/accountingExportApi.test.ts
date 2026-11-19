/**
 * @vitest-environment jsdom
 *
 * accountingExportApi (T21, specs/20261118-refund-accounting-export): the summary URL, the CSV as a Blob with its BOM kept,
 * the refusals' `code`s, the blocked-409 reader and the client-built filename.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import {
  accountingExportFileName,
  blockedSummary,
  downloadAccountingCsv,
  getAccountingExport,
} from './accountingExportApi'

const BASE = 'http://refund-api.test'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const blockers = {
  missingRates: [{ currency: 'EUR', month: '2026-03', reason: 'not_published' }],
  unclassifiedLines: [
    {
      lineId: 'l1',
      requestId: 'r1',
      date: '2026-03-19',
      type: 'travel_train',
      employee: 'Matteo Codogno',
      receiptNumber: 'MC26/014',
      missing: ['vatCode'],
    },
  ],
  unnumberedLines: [],
  accountingUnavailable: false,
}

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', BASE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('getAccountingExport', () => {
  it('GETs the summary of the batch, as the plan’s contract gives it', async () => {
    const summary = {
      batchId: 'b1',
      batchStatus: 'compiled',
      exportable: false,
      rowCount: 12,
      excludedLineCount: 3,
      ratePendingLineCount: 2,
      fetchAttempted: true,
      blockers: { ...blockers, accountingUnavailable: true },
      viewer: { canOpenAccountingRates: true },
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, summary))
    await expect(getAccountingExport('b1')).resolves.toEqual(summary)
    expect(String(vi.mocked(apiFetch).mock.calls[0][0])).toBe(`${BASE}/batches/b1/accounting-export`)
  })

  it('fills what an answer leaves out: no pending lines, no link, Accounting readable, no reason', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(200, {
        batchId: 'b1',
        batchStatus: 'compiled',
        exportable: false,
        rowCount: 0,
        excludedLineCount: 0,
        fetchAttempted: false,
        blockers: {
          missingRates: [{ currency: 'EUR', month: '2026-03' }, { currency: 'USD', month: '2026-03', reason: 'soon' }],
          unclassifiedLines: [],
          unnumberedLines: [],
        },
      }),
    )
    await expect(getAccountingExport('b1')).resolves.toMatchObject({
      ratePendingLineCount: 0,
      viewer: { canOpenAccountingRates: false },
      blockers: {
        accountingUnavailable: false,
        missingRates: [
          { currency: 'EUR', month: '2026-03', reason: null },
          { currency: 'USD', month: '2026-03', reason: null },
        ],
      },
    })
  })

  it('reads the viewer flag strictly: only true opens the link', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(200, { batchId: 'b1', exportable: true, viewer: { canOpenAccountingRates: 'yes' } }),
    )
    await expect(getAccountingExport('b1')).resolves.toMatchObject({ viewer: { canOpenAccountingRates: false } })
  })

  it('does not import the exchange-rates client any more (T37)', async () => {
    const source = await import('./accountingExportApi?raw')
    expect(source.default).not.toContain('exchangeRatesApi')
  })

  it.each([
    [403, 'accounting_export_out_of_scope'],
    [409, 'batch_discarded'],
  ])('passes the %i code %s through', async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(status, { title: 'x', status, code }))
    await expect(getAccountingExport('b1')).rejects.toMatchObject({ status, code })
  })
})

describe('downloadAccountingCsv', () => {
  it('GETs the csv route and returns the bytes as a Blob, byte-order mark kept', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Employee;Receipt number\r\n')])
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
    )

    const blob = await downloadAccountingCsv('b1')

    expect(String(vi.mocked(apiFetch).mock.calls[0][0])).toBe(`${BASE}/batches/b1/accounting-export/csv`)
    expect(blob).toBeInstanceOf(Blob)
    const received = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(received.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(received.length).toBe(bytes.length)
  })

  it('never reads the body as text (that would drop the BOM)', async () => {
    const response = new Response('x', { status: 200 })
    const text = vi.spyOn(response, 'text')
    vi.mocked(apiFetch).mockResolvedValueOnce(response)
    await downloadAccountingCsv('b1')
    expect(text).not.toHaveBeenCalled()
  })

  it('throws the 409 accounting_export_blocked with its body readable as the summary', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, {
        title: 'Conflict',
        status: 409,
        code: 'accounting_export_blocked',
        batchId: 'b1',
        batchStatus: 'compiled',
        exportable: false,
        rowCount: 0,
        excludedLineCount: 1,
        blockers,
        ratePendingLineCount: 3,
        fetchAttempted: true,
        viewer: { canOpenAccountingRates: true },
      }),
    )
    const error = await downloadAccountingCsv('b1').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 409, code: 'accounting_export_blocked' })
    expect(blockedSummary(error)).toEqual({
      batchId: 'b1',
      batchStatus: 'compiled',
      exportable: false,
      rowCount: 0,
      excludedLineCount: 1,
      blockers,
      ratePendingLineCount: 3,
      fetchAttempted: true,
      viewer: { canOpenAccountingRates: true },
    })
  })

  it('throws an ApiError for a 500 (no file was produced) and for a non-JSON body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(500, { title: 'Internal Server Error', status: 500 }))
    await expect(downloadAccountingCsv('b1')).rejects.toMatchObject({ status: 500 })

    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(downloadAccountingCsv('b1')).rejects.toMatchObject({ status: 502, title: 'Bad Gateway' })
  })

  it.each([
    [403, 'accounting_export_out_of_scope'],
    [409, 'batch_discarded'],
  ])('passes the %i code %s through', async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(status, { title: 'x', status, code }))
    await expect(downloadAccountingCsv('b1')).rejects.toMatchObject({ status, code })
  })
})

describe('blockedSummary', () => {
  it('is null for any other error and for a body that is not a summary', async () => {
    expect(blockedSummary(new Error('x'))).toBeNull()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(409, { title: 'x', status: 409, code: 'batch_discarded' }))
    expect(blockedSummary(await downloadAccountingCsv('b1').catch((caught: unknown) => caught))).toBeNull()

    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, { title: 'x', status: 409, code: 'accounting_export_blocked', batchId: 'b1' }),
    )
    expect(blockedSummary(await downloadAccountingCsv('b1').catch((caught: unknown) => caught))).toBeNull()
  })

  it('drops malformed blocker entries and defaults the counts', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, {
        title: 'x',
        status: 409,
        code: 'accounting_export_blocked',
        batchId: 'b1',
        blockers: {
          missingRates: [{ currency: 'JPY', month: '2026-03' }, { currency: 'USD', month: '2026-04' }, 5],
          unclassifiedLines: [{ lineId: 'l1' }, { lineId: 'l2', requestId: 'r2', missing: ['account', 'x'] }],
          unnumberedLines: [{ lineId: 'l3', requestId: 'r3', employee: 'A B' }, null],
        },
      }),
    )
    const summary = blockedSummary(await downloadAccountingCsv('b1').catch((caught: unknown) => caught))
    expect(summary).toMatchObject({
      exportable: false,
      rowCount: 0,
      excludedLineCount: 0,
      fetchAttempted: false,
      ratePendingLineCount: 0,
      viewer: { canOpenAccountingRates: false },
      blockers: {
        accountingUnavailable: false,
        missingRates: [{ currency: 'USD', month: '2026-04', reason: null }],
        unclassifiedLines: [
          {
            lineId: 'l2',
            requestId: 'r2',
            date: '',
            type: '',
            employee: '',
            receiptNumber: null,
            missing: ['account'],
          },
        ],
        unnumberedLines: [{ lineId: 'l3', requestId: 'r3', employee: 'A B' }],
      },
    })
  })
})

describe('blockedSummary: the specs/20261119-accounting fields', () => {
  it('reads the unavailable blocker, the pending count, the reasons and the viewer flag, and ignores unknown values', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(409, {
        title: 'x',
        status: 409,
        code: 'accounting_export_blocked',
        batchId: 'b1',
        ratePendingLineCount: 'many',
        viewer: { canOpenAccountingRates: 1 },
        blockers: {
          accountingUnavailable: true,
          missingRates: [
            { currency: 'EUR', month: '2026-03', reason: 'fetch_failed' },
            { currency: 'GBP', month: '2026-03', reason: 'who knows' },
          ],
        },
      }),
    )
    const summary = blockedSummary(await downloadAccountingCsv('b1').catch((caught: unknown) => caught))
    expect(summary).toMatchObject({
      ratePendingLineCount: 0,
      viewer: { canOpenAccountingRates: false },
      blockers: {
        accountingUnavailable: true,
        missingRates: [
          { currency: 'EUR', month: '2026-03', reason: 'fetch_failed' },
          { currency: 'GBP', month: '2026-03', reason: null },
        ],
      },
    })
  })
})

describe('accountingExportFileName', () => {
  it('is refund-accounting-<cutoff date>-<batch id>.csv from the batch cutoff instant', () => {
    expect(accountingExportFileName('2026-11-18T23:00:00.000Z', 'b1')).toBe('refund-accounting-2026-11-18-b1.csv')
    expect(accountingExportFileName('2026-11-18', 'clx9')).toBe('refund-accounting-2026-11-18-clx9.csv')
  })
})

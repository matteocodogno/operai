import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './api'
import { toInventoryError } from './types'

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
  confirmInvoiceUpload,
  getInvoiceFileUrl,
  INVOICE_MAX_BYTES,
  linkInvoiceFile,
  mintInvoiceUpload,
  uploadInvoiceFile,
  uploadToPresignedPost,
  validateInvoiceFile,
} from './invoiceFilesApi'

const mint = {
  entity: 'welld_ch' as const,
  invoiceRef: 'INV-1',
  fileName: 'inv.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: 1000,
}
const file = (name: string, type: string, size: number) => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('invoiceFilesApi — client-side pre-check (the server stays the authority)', () => {
  it('accepts pdf, jpeg and png up to 10 MiB inclusive', () => {
    expect(INVOICE_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(validateInvoiceFile(file('a.pdf', 'application/pdf', INVOICE_MAX_BYTES))).toBeNull()
    expect(validateInvoiceFile(file('a.jpg', 'image/jpeg', 1))).toBeNull()
    expect(validateInvoiceFile(file('a.png', 'image/png', 1))).toBeNull()
  })

  it('rejects one byte over 10 MiB as tooLarge and other types as unsupportedType', () => {
    expect(validateInvoiceFile(file('a.pdf', 'application/pdf', INVOICE_MAX_BYTES + 1))).toBe('tooLarge')
    expect(validateInvoiceFile(file('a.gif', 'image/gif', 1))).toBe('unsupportedType')
    expect(validateInvoiceFile(file('a', '', 1))).toBe('unsupportedType')
  })

  it('reports the type before the size when both are wrong', () => {
    expect(validateInvoiceFile(file('a.gif', 'image/gif', INVOICE_MAX_BYTES + 1))).toBe('unsupportedType')
  })
})

describe('invoiceFilesApi — mint, confirm, link, url', () => {
  it('POST /invoice-files sends the file metadata and returns the presigned post', async () => {
    const minted = { id: 'f-1', upload: { url: 'https://bucket.test', fields: { key: 'k' } } }
    vi.mocked(apiFetch).mockResolvedValue(ok(201, minted))

    await expect(mintInvoiceUpload(mint)).resolves.toEqual(minted)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/invoice-files`, method: 'POST', body: mint })
  })

  it('mint: 413 and 415 are plain ApiErrors carrying their status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(413))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(415))

    expect((await rejection(mintInvoiceUpload(mint))).status).toBe(413)
    expect((await rejection(mintInvoiceUpload(mint))).status).toBe(415)
  })

  it('POST /invoice-files/{id}/confirm has no body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { id: 'f-1', fileName: 'inv.pdf' }))

    await expect(confirmInvoiceUpload('f-1')).resolves.toEqual({ id: 'f-1', fileName: 'inv.pdf' })

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/invoice-files/f-1/confirm`,
      method: 'POST',
      rawBody: undefined,
    })
  })

  it('confirm: 409 upload_not_found maps to the known error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'upload_not_found' }))

    expect(toInventoryError(await rejection(confirmInvoiceUpload('f-1')))).toMatchObject({
      code: 'upload_not_found',
      status: 409,
    })
  })

  it('PUT /invoice-files/{id}/assets sends {assetIds} and returns the linked ids', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { linked: ['a-1', 'a-2'] }))

    await expect(linkInvoiceFile('f-1', ['a-1', 'a-2'])).resolves.toEqual({ linked: ['a-1', 'a-2'] })

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/invoice-files/f-1/assets`,
      method: 'PUT',
      body: { assetIds: ['a-1', 'a-2'] },
    })
  })

  it.each(['invoice_ref_mismatch', 'asset_disposed'])('link: 409 %s names the asset', async (code) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code, assetId: 'a-2' }))

    expect(toInventoryError(await rejection(linkInvoiceFile('f-1', ['a-2'])))).toMatchObject({
      code,
      extras: { assetId: 'a-2' },
    })
  })

  it('GET /invoice-files/{id}/url returns the short-lived URL; 404 is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(200, { url: 'https://signed.test', expiresInSeconds: 60 }))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(404))

    await expect(getInvoiceFileUrl('f-1')).resolves.toEqual({ url: 'https://signed.test', expiresInSeconds: 60 })
    expect(lastRequest()).toMatchObject({ url: `${BASE}/invoice-files/f-1/url`, method: 'GET' })
    expect((await rejection(getInvoiceFileUrl('f-1'))).status).toBe(404)
  })
})

describe('invoiceFilesApi — the bucket upload never uses apiFetch', () => {
  it('POSTs the policy fields then the file (last) with the global fetch and no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const f = file('inv.pdf', 'application/pdf', 10)

    await uploadToPresignedPost({ url: 'https://bucket.test', fields: { key: 'k1', policy: 'p' } }, f)

    expect(apiFetch).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://bucket.test')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
    expect([...(init.body as FormData).keys()]).toEqual(['key', 'policy', 'file'])
  })

  it('a non-2xx bucket response throws, carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))

    await expect(
      uploadToPresignedPost({ url: 'https://bucket.test', fields: {} }, file('a.pdf', 'application/pdf', 1)),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('uploadInvoiceFile runs mint, bucket upload and confirm in order and returns the stored file', async () => {
    const calls: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      calls.push(String(url).replace(BASE, ''))
      return String(url).endsWith('/confirm')
        ? ok(200, { id: 'f-1', fileName: 'inv.pdf' })
        : ok(201, { id: 'f-1', upload: { url: 'https://bucket.test', fields: {} } })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        calls.push('bucket')
        return new Response(null, { status: 204 })
      }),
    )

    const stored = await uploadInvoiceFile('welld_ch', 'INV-1', file('inv.pdf', 'application/pdf', 10))

    expect(stored).toEqual({ id: 'f-1', fileName: 'inv.pdf' })
    expect(calls).toEqual(['/invoice-files', 'bucket', '/invoice-files/f-1/confirm'])
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]?.body as string)).toEqual({
      entity: 'welld_ch',
      invoiceRef: 'INV-1',
      fileName: 'inv.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    })
  })

  it('uploadInvoiceFile stops after a failed bucket upload: confirm is never called', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(201, { id: 'f-1', upload: { url: 'https://bucket.test', fields: {} } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    await expect(uploadInvoiceFile('welld_ch', 'INV-1', file('inv.pdf', 'application/pdf', 10))).rejects.toThrow()

    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1)
  })
})

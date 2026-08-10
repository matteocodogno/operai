/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/attachmentsApi.ts (T17, specs/007-refund-service/
 * tasks.md). Strategy mirrors requestsApi.test.ts for the refund-api-bound
 * calls (mock `shell/session`'s `apiFetch`), plus a dedicated block for
 * `uploadToPresignedPost`, which deliberately does NOT go through
 * `apiFetch` — it mocks the global `fetch` instead, since that call must
 * never carry the suite's Bearer JWT (ADR-0001).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import {
  confirmUpload,
  getDownloadUrl,
  isAllowedContentType,
  mintUpload,
  removeAttachment,
  uploadAttachment,
  uploadToPresignedPost,
  validateFileForUpload,
} from './attachmentsApi'

const REFUND_API_URL = 'http://refund-api.test'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const pdfFile = (name = 'receipt.pdf', sizeBytes = 1024): File => {
  const file = new File([new Uint8Array(sizeBytes)], name, { type: 'application/pdf' })
  return file
}

describe('validateFileForUpload / isAllowedContentType', () => {
  it('accepts pdf/jpeg/png under the size cap', () => {
    expect(isAllowedContentType('application/pdf')).toBe(true)
    expect(isAllowedContentType('image/jpeg')).toBe(true)
    expect(isAllowedContentType('image/png')).toBe(true)
    expect(validateFileForUpload(pdfFile())).toBeNull()
  })

  it('rejects an unsupported content type', () => {
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    expect(validateFileForUpload(file)).toBe('unsupportedType')
  })

  it('rejects a file over the 10 MiB cap', () => {
    const file = pdfFile('big.pdf', 10 * 1024 * 1024 + 1)
    expect(validateFileForUpload(file)).toBe('tooLarge')
  })
})

describe('mint / confirm / remove / getDownloadUrl', () => {
  it('mintUpload POSTs /requests/:id/lines/:lineId/attachments', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(201, { attachmentId: 'a1', upload: { url: 'https://bucket', fields: {}, objectKey: 'k' } }),
    )
    await mintUpload('r1', 'l1', { fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines/l1/attachments`)
    expect(init?.method).toBe('POST')
  })

  it('confirmUpload POSTs the /confirm sub-route with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'a1',
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        uploadStatus: 'stored',
      }),
    )
    await confirmUpload('r1', 'l1', 'a1')
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines/l1/attachments/a1/confirm`)
    expect(init?.method).toBe('POST')
  })

  it('removeAttachment DELETEs the attachment, 409 when not draft', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }),
    )
    await expect(removeAttachment('r1', 'l1', 'a1')).rejects.toMatchObject({ status: 409 })
  })

  it('getDownloadUrl GETs the /url sub-route', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, { url: 'https://signed', expiresAt: '2026-07-16T00:01:00.000Z' }),
    )
    const result = await getDownloadUrl('r1', 'l1', 'a1')
    expect(result.url).toBe('https://signed')
    const [url] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines/l1/attachments/a1/url`)
  })
})

describe('uploadToPresignedPost', () => {
  it('POSTs a multipart/form-data body to the presigned URL via the global fetch, not apiFetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadToPresignedPost(
      { url: 'https://bucket.example/upload', fields: { key: 'refund/x', policy: 'p' } },
      pdfFile(),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetch).not.toHaveBeenCalled()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bucket.example/upload')
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body.get('key')).toBe('refund/x')
    expect(body.get('policy')).toBe('p')
    expect(body.get('file')).toBeInstanceOf(File)
  })

  it('throws when the bucket responds non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))

    await expect(
      uploadToPresignedPost({ url: 'https://bucket.example/upload', fields: {} }, pdfFile()),
    ).rejects.toThrow(/403/)
  })
})

describe('uploadAttachment (composed mint -> upload -> confirm)', () => {
  it('calls mint, then the bucket, then confirm, in order, and returns the stored attachment', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        jsonResponse(201, {
          attachmentId: 'a1',
          upload: { url: 'https://bucket.example/upload', fields: { key: 'k' }, objectKey: 'k' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'a1',
          fileName: 'receipt.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          uploadStatus: 'stored',
        }),
      )
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await uploadAttachment('r1', 'l1', pdfFile())

    expect(result).toMatchObject({ id: 'a1', uploadStatus: 'stored' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    const [mintUrl] = vi.mocked(apiFetch).mock.calls[0]
    const [confirmUrl] = vi.mocked(apiFetch).mock.calls[1]
    expect(String(mintUrl)).toContain('/attachments')
    expect(String(confirmUrl)).toContain('/attachments/a1/confirm')
  })

  it('propagates a mint-time 409 (request no longer draft) without touching the bucket', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadAttachment('r1', 'l1', pdfFile())).rejects.toMatchObject({ status: 409 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates a bucket-upload failure without calling confirm', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(201, {
        attachmentId: 'a1',
        upload: { url: 'https://bucket.example/upload', fields: {}, objectKey: 'k' },
      }),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    await expect(uploadAttachment('r1', 'l1', pdfFile())).rejects.toThrow()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})

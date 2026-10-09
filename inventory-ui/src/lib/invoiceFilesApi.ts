import { getJson, sendJson } from './api'
import type { Entity, InvoiceContentType, InvoiceUploadRequest, MintedInvoiceUpload, StoredInvoiceFile } from './types'

/**
 * Invoice files (either capability, scoped to `entity`): mint a presigned POST,
 * upload to the EU bucket, confirm, then link to assets sharing the invoice
 * reference. The bucket step never goes through `apiFetch` — the suite's
 * Bearer JWT must not reach the storage provider's origin (ADR-0001; the same
 * rule as refund-ui's attachments). There is no unlink route.
 */

/** Mirrors the server policy (10 MiB, pdf/jpeg/png); a fast pre-check only, the server re-enforces it (413/415). */
export const INVOICE_MAX_BYTES = 10 * 1024 * 1024
export const INVOICE_CONTENT_TYPES: readonly InvoiceContentType[] = ['application/pdf', 'image/jpeg', 'image/png']

export type InvoiceRejectionReason = 'tooLarge' | 'unsupportedType'

/** The rejection reason for a file that fails the client-side pre-check, or null. Type is checked before size. */
export const validateInvoiceFile = (file: File): InvoiceRejectionReason | null => {
  if (!(INVOICE_CONTENT_TYPES as readonly string[]).includes(file.type)) return 'unsupportedType'
  if (file.size > INVOICE_MAX_BYTES) return 'tooLarge'
  return null
}

export const mintInvoiceUpload = (request: InvoiceUploadRequest): Promise<MintedInvoiceUpload> =>
  sendJson<MintedInvoiceUpload>('/invoice-files', 'POST', request)

/** Thrown when the bucket refuses the upload; carries its HTTP status. */
export class StorageUploadError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Upload to storage failed with status ${status}`)
    this.name = 'StorageUploadError'
    this.status = status
  }
}

/** POSTs the policy `fields` then the `file` (last, as S3 POST policies require) with the global `fetch`. */
export const uploadToPresignedPost = async (upload: MintedInvoiceUpload['upload'], file: File): Promise<void> => {
  const form = new FormData()
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value)
  form.append('file', file)
  const response = await fetch(upload.url, { method: 'POST', body: form })
  if (!response.ok) throw new StorageUploadError(response.status)
}

/** 409 `upload_not_found` when the object is missing or its size does not match. */
export const confirmInvoiceUpload = (id: string): Promise<StoredInvoiceFile> =>
  sendJson<StoredInvoiceFile>(`/invoice-files/${encodeURIComponent(id)}/confirm`, 'POST')

/** Mint, upload, confirm. A failure in any phase throws and later phases do not run. */
export const uploadInvoiceFile = async (entity: Entity, invoiceRef: string, file: File): Promise<StoredInvoiceFile> => {
  const minted = await mintInvoiceUpload({
    entity,
    invoiceRef,
    fileName: file.name,
    contentType: file.type as InvoiceContentType,
    sizeBytes: file.size,
  })
  await uploadToPresignedPost(minted.upload, file)
  return confirmInvoiceUpload(minted.id)
}

/** Links the file to each asset (replacing any earlier link). 409 `invoice_ref_mismatch` / `asset_disposed` name the asset. */
export const linkInvoiceFile = (id: string, assetIds: string[]): Promise<{ linked: string[] }> =>
  sendJson<{ linked: string[] }>(`/invoice-files/${encodeURIComponent(id)}/assets`, 'PUT', { assetIds })

/** A fresh 60-second URL — ask again on every open, never cache it. */
export const getInvoiceFileUrl = (id: string, init?: RequestInit): Promise<{ url: string; expiresInSeconds: number }> =>
  getJson<{ url: string; expiresInSeconds: number }>(`/invoice-files/${encodeURIComponent(id)}/url`, init)

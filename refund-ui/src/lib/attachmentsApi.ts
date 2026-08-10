/**
 * attachmentsApi — typed line-attachment operations against `refund-api`'s
 * attachment endpoints (T17, specs/007-refund-service/tasks.md; plan.md
 * "## Object storage" + "### Employee endpoints"), built on `./refundApi.ts`'s
 * generic `getJson`/`sendJson`/`deleteJson` plumbing, mirroring
 * `./requestsApi.ts`'s own convention.
 *
 * Routes (transcribed verbatim from `refund-api/src/attachments/
 * attachments.routes.ts` — T9 is implemented, unlike the employee/lifecycle
 * routes T16 had to build against a not-yet-existing contract):
 *
 *   POST   /requests/:id/lines/:lineId/attachments             → mint (draft-only)
 *   POST   /requests/:id/lines/:lineId/attachments/:aid/confirm → HEAD-verify → stored
 *   DELETE /requests/:id/lines/:lineId/attachments/:aid        → draft-only, deletes object too
 *   GET    /requests/:id/lines/:lineId/attachments/:aid/url    → signed GET, owner OR in-scope accounting
 *
 * DRIFT NOTE (flagged in this task's implementation report): design.md's F1
 * step 5 prose says "direct PUT to the presigned EU bucket URL", but the
 * actual (T9, already-implemented) contract mints a presigned **POST**
 * (`upload: { url, fields, objectKey }` — an S3 POST policy, not a PUT
 * target), which plan.md's own "## Object storage" section states correctly
 * ("refund-api mints a presigned POST"). This module follows the real
 * backend/plan.md contract, not design.md's imprecise paraphrase —
 * `uploadToPresignedPost` below POSTs a `multipart/form-data` body built from
 * `upload.fields` + the file (RFC "file field last" convention for S3 POST
 * policies), never a PUT.
 *
 * The bucket upload step is deliberately **not** an `apiFetch`/`refund-api`
 * call at all — it POSTs directly to the presigned bucket URL using the
 * global `fetch`, never `shell/session`'s `apiFetch` (ADR-0001's Bearer JWT
 * must never reach the storage provider's origin; plan.md "Object storage":
 * "the browser uploads directly to the EU bucket").
 */

import type { Attachment } from './requestsApi'
import { deleteJson, getJson, sendJson } from './refundApi'

// ---------------------------------------------------------------------------
// Client-side validation constants (mirrors refund-api's ADR-0016 policy —
// re-declared here since refund-ui cannot import refund-api's `src/lib/
// storage.ts` across the service boundary; the server re-enforces every one
// of these inside the signed POST policy + at `confirm` time regardless, so
// this is a fast, friendly pre-check, never the authority).
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MiB

export type AttachmentContentType = 'application/pdf' | 'image/jpeg' | 'image/png'

export const ALLOWED_CONTENT_TYPES: readonly AttachmentContentType[] = ['application/pdf', 'image/jpeg', 'image/png']

export const isAllowedContentType = (contentType: string): contentType is AttachmentContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)

export type AttachmentRejectionReason = 'tooLarge' | 'unsupportedType'

/** Returns the rejection reason for a file that fails the client-side pre-check, or `null` if it passes. */
export const validateFileForUpload = (file: File): AttachmentRejectionReason | null => {
  if (!isAllowedContentType(file.type)) return 'unsupportedType'
  if (file.size > MAX_ATTACHMENT_BYTES) return 'tooLarge'
  return null
}

// ---------------------------------------------------------------------------
// Shapes (refund-api/src/attachments/attachments.schemas.ts)
// ---------------------------------------------------------------------------

export type MintedUpload = {
  attachmentId: string
  upload: { url: string; fields: Record<string, string>; objectKey: string }
}

export type AttachmentStored = Attachment & { uploadStatus: 'stored' }

export type SignedDownloadUrl = { url: string; expiresAt: string }

// ---------------------------------------------------------------------------
// Phase 1 — mint
// ---------------------------------------------------------------------------

export const mintUpload = (
  requestId: string,
  lineId: string,
  body: { fileName: string; contentType: AttachmentContentType; sizeBytes: number },
): Promise<MintedUpload> => sendJson<MintedUpload>(`/requests/${requestId}/lines/${lineId}/attachments`, 'POST', body)

// ---------------------------------------------------------------------------
// Phase 2 — direct-to-bucket upload (NOT refund-api, NOT apiFetch)
// ---------------------------------------------------------------------------

/**
 * POSTs the file directly to the presigned EU bucket URL minted by
 * `mintUpload` — a `multipart/form-data` body carrying the signed policy's
 * `fields` first and the file itself LAST (S3's presigned-POST convention:
 * fields after `file` are ignored). Uses the global `fetch`, never
 * `apiFetch` — this request must never carry the suite's Bearer JWT.
 */
export const uploadToPresignedPost = async (
  upload: { url: string; fields: Record<string, string> },
  file: File,
): Promise<void> => {
  const formData = new FormData()
  for (const [key, value] of Object.entries(upload.fields)) {
    formData.append(key, value)
  }
  formData.append('file', file)

  const response = await fetch(upload.url, { method: 'POST', body: formData })
  if (!response.ok) {
    throw new Error(`Upload to storage failed with status ${response.status}`)
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — confirm
// ---------------------------------------------------------------------------

export const confirmUpload = (requestId: string, lineId: string, attachmentId: string): Promise<AttachmentStored> =>
  sendJson<AttachmentStored>(
    `/requests/${requestId}/lines/${lineId}/attachments/${attachmentId}/confirm`,
    'POST',
    undefined,
  )

// ---------------------------------------------------------------------------
// Composed 3-phase upload — the one place mint→upload→confirm sequencing
// lives, so RequestDetailPage doesn't re-derive it (and so AttachmentList's
// per-file phase state machine only needs one "uploading" span, not three).
// Throws on any phase's failure — the caller (RequestDetailPage) is
// responsible for mapping a 409 (request no longer draft) to GuardrailDialog,
// same as every other draft-only mutation (T16's `runLineMutation`).
// ---------------------------------------------------------------------------

export const uploadAttachment = async (requestId: string, lineId: string, file: File): Promise<AttachmentStored> => {
  const minted = await mintUpload(requestId, lineId, {
    fileName: file.name,
    contentType: file.type as AttachmentContentType,
    sizeBytes: file.size,
  })
  await uploadToPresignedPost(minted.upload, file)
  return confirmUpload(requestId, lineId, minted.attachmentId)
}

// ---------------------------------------------------------------------------
// Remove (draft-only) / mint a signed download URL
// ---------------------------------------------------------------------------

export const removeAttachment = (requestId: string, lineId: string, attachmentId: string): Promise<void> =>
  deleteJson(`/requests/${requestId}/lines/${lineId}/attachments/${attachmentId}`)

/** `GET …/attachments/:aid/url` — owner OR in-scope accounting only (404 otherwise); ~60s presigned GET. */
export const getDownloadUrl = (requestId: string, lineId: string, attachmentId: string): Promise<SignedDownloadUrl> =>
  getJson<SignedDownloadUrl>(`/requests/${requestId}/lines/${lineId}/attachments/${attachmentId}/url`)

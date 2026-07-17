/**
 * AttachmentList — per-line receipt attachments (T17, specs/007-refund-service/
 * tasks.md; design.md F1 step 5, Component inventory: "AttachmentList /
 * per-file upload state machine — trigger-button convention ported from
 * EstimatesPage.tsx's hidden-file-input pattern; the phase-state-machine
 * shape ported from ImportOfferModal.tsx (offer/importing/results →
 * generalized to per-file queued/uploading/stored/failed)"). Fills the seam
 * T16 left in `ExpenseLineRow`/`RequestDetailPage`
 * (`row-${line.id}-attachments-seam`).
 *
 * Two modes:
 *   - `edit` (Screen R2 draft): "+ Attach files" (hidden multi-file input,
 *     `EstimatesPage.tsx`'s ref+button-click trigger convention). Each
 *     selected file is checked client-side first (≤10 MiB,
 *     pdf/jpeg/png — `lib/attachmentsApi.ts`'s `validateFileForUpload`); a
 *     failing file is never silently dropped, it renders `rejected` with an
 *     inline reason. A passing file enters `queued → uploading →
 *     stored/failed` (the three-phase mint→bucket→confirm sequence in
 *     `lib/attachmentsApi.ts`'s `uploadAttachment` collapses to ONE
 *     "uploading" span — from the UI's perspective all three phases are
 *     equally "in flight"; design.md only asks for these four states).
 *     Already-persisted attachments render via `AttachmentDownloadLink` plus
 *     a "×" Remove (draft-only, no confirm — design.md F1 step 5).
 *   - `readOnly` (accounting's Screen A2, and the employee's own
 *     submitted/approved/rejected views): persisted attachments render via
 *     `AttachmentDownloadLink` only — no upload/remove affordances at all.
 *
 * The three async operations (upload/remove/download) arrive as callback
 * props bound to a specific request+line by the caller (`RequestDetailPage`/
 * `ReviewDetailPage`, via `lib/attachmentsApi.ts`) — this component owns
 * only the per-file UI phase state locally, the same way `ExpenseLineRow`
 * owns its own draft-buffering state while delegating the actual `PUT` to a
 * callback prop.
 *
 * A11y (design.md "## Accessibility" — "Attachments"): each in-flight file's
 * status is announced via a per-file `aria-live="polite"` region (queued →
 * uploading → stored/failed), mirroring `ImportOfferModal.tsx`'s own
 * results-announcement convention; a failed/rejected file's reason renders
 * inline, associated with that file's row, never only as a vanished item.
 */

import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { strings } from '../strings'
import type { Attachment } from '../lib/requestsApi'
import { validateFileForUpload } from '../lib/attachmentsApi'
import AttachmentDownloadLink from './AttachmentDownloadLink'

export type AttachmentListMode = 'edit' | 'readOnly'

type UploadItem =
  | { localId: string; fileName: string; status: 'queued' }
  | { localId: string; fileName: string; status: 'uploading' }
  | { localId: string; fileName: string; status: 'stored'; attachment: Attachment }
  | { localId: string; fileName: string; status: 'failed'; reason: string }
  | { localId: string; fileName: string; status: 'rejected'; reason: string }

export type AttachmentListProps = {
  /** Used only to namespace this instance's DOM ids/testids among sibling lines. */
  lineId: string
  /** Persisted, `stored` attachments already on this line (`RefundLine.attachments`). */
  attachments: Attachment[]
  mode: AttachmentListMode
  /** Required in `edit` mode. Performs the full mint→upload→confirm sequence for one file. */
  onUpload?: (file: File) => Promise<Attachment>
  /** Required in `edit` mode. Removes a persisted attachment (draft-only, no confirm). */
  onRemove?: (attachmentId: string) => Promise<void>
  /** Required in both modes — a receipt is downloadable everywhere it's visible. */
  onDownload: (attachmentId: string) => Promise<{ url: string }>
}

const newLocalId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `local-${Math.random().toString(36).slice(2)}`

export default function AttachmentList({ lineId, attachments, mode, onUpload, onRemove, onDownload }: AttachmentListProps) {
  const t = strings.components.attachmentList
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([])
  const [removingId, setRemovingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Once the parent reloads the request after a successful upload, the newly
  // stored attachment shows up in `attachments` — drop the local duplicate
  // rather than tracking a second source of truth for it.
  const visibleUploadItems = uploadItems.filter(
    (item) => !(item.status === 'stored' && attachments.some((a) => a.id === item.attachment.id)),
  )

  const updateItem = (localId: string, next: UploadItem) => {
    setUploadItems((prev) => prev.map((item) => (item.localId === localId ? next : item)))
  }

  const processFile = async (localId: string, file: File) => {
    if (!onUpload) return
    updateItem(localId, { localId, fileName: file.name, status: 'uploading' })
    try {
      const attachment = await onUpload(file)
      updateItem(localId, { localId, fileName: file.name, status: 'stored', attachment })
    } catch {
      updateItem(localId, { localId, fileName: file.name, status: 'failed', reason: t.statusFailed })
    }
  }

  const handleFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-selecting the same file after a rejection/failure
    if (files.length === 0) return

    for (const file of files) {
      const localId = newLocalId()
      const rejection = validateFileForUpload(file)
      if (rejection) {
        setUploadItems((prev) => [
          ...prev,
          { localId, fileName: file.name, status: 'rejected', reason: rejection === 'tooLarge' ? t.rejectedTooLarge : t.rejectedType },
        ])
        continue
      }
      setUploadItems((prev) => [...prev, { localId, fileName: file.name, status: 'queued' }])
      void processFile(localId, file)
    }
  }

  const handleRemove = async (attachmentId: string) => {
    if (!onRemove) return
    setRemovingId(attachmentId)
    try {
      await onRemove(attachmentId)
    } finally {
      setRemovingId(null)
    }
  }

  const dismissUploadItem = (localId: string) => {
    setUploadItems((prev) => prev.filter((item) => item.localId !== localId))
  }

  const statusLabel = (item: UploadItem): string => {
    switch (item.status) {
      case 'queued':
        return t.statusQueued
      case 'uploading':
        return t.statusUploading
      case 'stored':
        return t.statusStored
      case 'failed':
      case 'rejected':
        return item.reason
    }
  }

  const hasAnyRows = attachments.length > 0 || visibleUploadItems.length > 0

  return (
    <div className="flex flex-col gap-2" data-testid={`attachment-list-${lineId}`}>
      {hasAnyRows && (
        <ul className="flex flex-col gap-1.5">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-2">
              <AttachmentDownloadLink attachment={attachment} onDownload={onDownload} />
              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={() => void handleRemove(attachment.id)}
                  disabled={removingId === attachment.id}
                  aria-label={t.removeLabel(attachment.fileName)}
                  title={t.removeTitle}
                  data-testid={`attachment-remove-${attachment.id}`}
                  className="text-sm leading-none transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ color: 'var(--muted)' }}
                >
                  ×
                </button>
              )}
            </li>
          ))}

          {visibleUploadItems.map((item) => {
            const isTerminalIssue = item.status === 'failed' || item.status === 'rejected'
            return (
              <li
                key={item.localId}
                className="flex items-center gap-2 text-xs"
                data-testid={`attachment-upload-${item.localId}`}
              >
                <span style={{ color: 'var(--text)' }}>{item.fileName}</span>
                <span
                  aria-live="polite"
                  role={isTerminalIssue ? 'alert' : undefined}
                  data-testid={`attachment-upload-${item.localId}-status`}
                  style={{ color: isTerminalIssue ? 'var(--red)' : 'var(--muted)' }}
                >
                  {statusLabel(item)}
                </span>
                {isTerminalIssue && (
                  <button
                    type="button"
                    onClick={() => dismissUploadItem(item.localId)}
                    aria-label={t.dismissLabel(item.fileName)}
                    data-testid={`attachment-upload-${item.localId}-dismiss`}
                    className="text-sm leading-none transition-opacity hover:opacity-80"
                    style={{ color: 'var(--muted)' }}
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {mode === 'edit' && (
        <div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            data-testid={`attachment-attach-button-${lineId}`}
            className="text-[11px] font-medium border px-2 py-1 transition-opacity hover:opacity-80"
            style={{ borderColor: 'var(--rule)', color: 'var(--soft)' }}
          >
            {t.attachButton}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            onChange={handleFilesSelected}
            className="hidden"
            data-testid={`attachment-input-${lineId}`}
          />
        </div>
      )}
    </div>
  )
}

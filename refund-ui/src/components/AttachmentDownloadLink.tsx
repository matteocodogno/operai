/**
 * AttachmentDownloadLink — click-to-download control for one stored receipt
 * attachment (T17, specs/007-refund-service/tasks.md; design.md F6 step 1,
 * Component inventory: "AttachmentDownloadLink (accounting's read-only
 * mode) … click → mint presigned GET → open"). Used by `AttachmentList` in
 * BOTH modes — `readOnly` (accounting's Screen A2, and the employee's own
 * submitted/approved/rejected views) AND alongside each already-uploaded
 * attachment in `edit` mode (a stored receipt is downloadable even while the
 * request is still a draft).
 *
 * Presentational except for its own minting call: `onDownload` is the one
 * async operation this component performs itself, exactly the way
 * `AttachmentList` (../components/AttachmentList.tsx) owns its own per-file
 * upload phase state while the actual HTTP calls arrive as callback props
 * built on `lib/attachmentsApi.ts` — no in-repo dialog/list component call
 * an API module directly today (RequestDetailPage/MyRequestsPage do, but
 * ImportOfferModal.tsx/ExpenseLineRow.tsx don't), so a single small async
 * click-handler here is a deliberately narrow exception, not a new pattern
 * for larger components to imitate.
 */

import { useState } from 'react'
import { strings } from '../strings'
import type { Attachment } from '../lib/requestsApi'

export type AttachmentDownloadLinkProps = {
  attachment: Attachment
  /** Mints a short-lived signed GET for this attachment (`lib/attachmentsApi.ts`'s `getDownloadUrl`, bound to the owning request/line by the caller). */
  onDownload: (attachmentId: string) => Promise<{ url: string }>
}

export default function AttachmentDownloadLink({ attachment, onDownload }: AttachmentDownloadLinkProps) {
  const t = strings.components.attachmentList
  const [state, setState] = useState<'idle' | 'minting' | 'error'>('idle')

  const handleClick = async () => {
    setState('minting')
    try {
      const { url } = await onDownload(attachment.id)
      window.open(url, '_blank', 'noopener,noreferrer')
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={state === 'minting'}
        aria-label={t.downloadLabel(attachment.fileName)}
        data-testid={`attachment-download-${attachment.id}`}
        className="text-xs underline underline-offset-2 transition-opacity hover:opacity-80 disabled:opacity-40"
        style={{ color: 'var(--acc)' }}
      >
        <span aria-hidden="true">📎</span> {attachment.fileName}
      </button>
      {state === 'error' && (
        <span
          role="alert"
          data-testid={`attachment-download-${attachment.id}-error`}
          className="text-[11px]"
          style={{ color: 'var(--red)' }}
        >
          {t.downloadError}
        </span>
      )}
    </span>
  )
}

/**
 * BatchPdfLink — click-to-download control for a batch's compiled PDF (T10,
 * specs/008-refund-monthly-processing/tasks.md; design.md F2 step 2: "a NEW
 * BatchPdfLink, click → mint → open, following AttachmentDownloadLink's exact
 * contract (GET /batches/:id/pdf-url, then window.open(url, '_blank',
 * 'noopener,noreferrer')) rather than reusing the pdf.url embedded in the
 * initial GET /batches/:id response — that embedded URL is only ~60s fresh
 * … re-minting on every click guarantees the link is never stale regardless
 * of dwell time").
 *
 * A `<button>`, never a static `<a href>` — the signed URL is short-lived, so
 * a plain anchor with a stale `href` would be actively wrong after the link
 * goes cold (design.md Accessibility: "Download-PDF action semantics").
 *
 * Calls `batchesApi.getPdfUrl` directly (this task's own brief: "on click
 * calls batchesApi.getPdfUrl(id) and opens the returned URL") rather than
 * taking a callback prop the way `AttachmentDownloadLink` does — a narrow,
 * self-contained exception scoped to this one component, mirroring
 * `AttachmentDownloadLink`'s own idle/minting/error state machine otherwise.
 *
 * Its accessible name names the batch reference explicitly ("Download
 * compiled PDF for batch `<reference>`") — `reference` is the batch `id`
 * (plan.md's `batchReference`/email-template field is the same `id`, no
 * separate reference number exists on the wire, design.md's Screen B3 note).
 * A minting failure surfaces inline next to the button (`role="alert"`)
 * rather than silently doing nothing.
 */

import { useState } from 'react'
import { strings } from '../strings'
import * as batchesApi from '../lib/batchesApi'

export type BatchPdfLinkProps = {
  batchId: string
}

export default function BatchPdfLink({ batchId }: BatchPdfLinkProps) {
  const t = strings.components.batchPdfLink
  const [state, setState] = useState<'idle' | 'minting' | 'error'>('idle')

  const handleClick = async () => {
    setState('minting')
    try {
      const { url } = await batchesApi.getPdfUrl(batchId)
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
        aria-label={t.downloadLabel(batchId)}
        data-testid={`batch-pdf-link-${batchId}`}
        className="text-xs font-medium border px-2.5 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40"
        style={{ borderColor: 'var(--rule)', color: 'var(--acc)' }}
      >
        <span aria-hidden="true">📄</span> {t.buttonLabel}
      </button>
      {state === 'error' && (
        <span
          role="alert"
          data-testid={`batch-pdf-link-${batchId}-error`}
          className="text-[11px]"
          style={{ color: 'var(--red)' }}
        >
          {t.downloadError}
        </span>
      )}
    </span>
  )
}

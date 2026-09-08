/**
 * RequestExportLink — click-to-download control for a request's archive PDF
 * (ADR-0043): every expense line plus every receipt, in one file, for filing.
 *
 * A `<button>` rather than an `<a href>`, for a different reason than
 * `BatchPdfLink`'s. That one avoids an anchor because its presigned URL goes
 * stale in ~60s; this one avoids it because the endpoint is authenticated by
 * the in-memory Bearer JWT (ADR-0001), which a top-level navigation would
 * never send — there is no URL a browser could follow on its own. The bytes
 * are fetched and handed over as a Blob.
 *
 * The object URL is revoked immediately after the click is dispatched. It is
 * a handle to a multi-megabyte Blob held in memory; leaking one per export
 * would accumulate for the life of the tab.
 *
 * Failures are distinguished rather than collapsed into "try again": 413 and
 * 502 are not retryable and need an administrator, so telling someone to
 * retry would be wrong advice. Errors surface inline (`role="alert"`) next to
 * the button, mirroring BatchPdfLink.
 */

import { useState } from 'react'
import { strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'

export type RequestExportLinkProps = {
  requestId: string
}

export default function RequestExportLink({ requestId }: RequestExportLinkProps) {
  const t = strings.components.requestExportLink
  const [state, setState] = useState<'idle' | 'exporting'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleClick = async () => {
    setState('exporting')
    setError(null)
    let objectUrl: string | null = null
    try {
      const blob = await requestsApi.exportPdf(requestId)
      objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `refund-request-${requestId}.pdf`
      anchor.click()
    } catch (caught) {
      const status = caught instanceof ApiError ? caught.status : undefined
      setError(
        status === 413
          ? t.tooLargeError
          : status === 502
            ? t.receiptError
            : status === 409
              ? t.notArchivableError
              : t.genericError,
      )
    } finally {
      // Release the Blob handle regardless of outcome — the click has already
      // been dispatched synchronously above, so the download is unaffected.
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
      setState('idle')
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={state === 'exporting'}
        aria-label={t.downloadLabel(requestId)}
        data-testid={`request-export-link-${requestId}`}
        className="text-xs font-medium border px-2.5 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40"
        style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
      >
        {state === 'exporting' ? t.exporting : t.buttonLabel}
      </button>
      {error !== null && (
        <span role="alert" className="text-xs" style={{ color: 'var(--red)' }}>
          {error}
        </span>
      )}
    </span>
  )
}

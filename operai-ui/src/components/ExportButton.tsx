import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'

export type ExportButtonProps = {
  label: string
  /**
   * Builds the file when the person clicks (the app fetches its pages and lazy-imports its
   * spreadsheet library here, so none of it is in the page's bundle). `data` is what a `Blob`
   * takes (an `ArrayBuffer` from `exceljs`' `writeBuffer()`, a string). `readyMessage` replaces
   * `messages.ready` when the file is made but the app has something to say about it ("File
   * ready. Some names could not be loaded and are missing."). A rejection, or a throw, is the
   * failure the person sees as `messages.failed`.
   */
  build: () => Promise<{ data: BlobPart; fileName: string; readyMessage?: string }>
  messages: {
    /** The polite status while `build` runs. */
    busy: string
    /** The polite status once the file has been handed to the browser. */
    ready: string
    /** The alert when `build` or the download fails; the same button tries again. */
    failed: string
  }
  /** The file's type. Default the XLSX one. */
  mimeType?: string
  /**
   * A status belongs to what was exported: when this changes (the filters did) the "ready" or
   * "failed" line is cleared, because it describes a file of something else. A file that was still
   * being built is handed over all the same, and says nothing.
   */
  resetKey?: string
  variant?: 'secondary' | 'ghost'
  /** `data-testid` of the button; the status line is `<testId>-status`, the alert `<testId>-error`. */
  testId: string
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * How long the object URL lives after the click. A browser starts reading it asynchronously, and
 * revoking it at once can cancel the download in some of them.
 */
const REVOKE_DELAY_MS = 30_000

type Outcome =
  { forKey: string | undefined; kind: 'ready'; message: string } | { forKey: string | undefined; kind: 'failed' }

const download = (data: BlobPart, fileName: string, mimeType: string): void => {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
  // Revoked even when the click throws; the timer outlives the component, which is harmless.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  // Attached for the click: some browsers ignore a click on an anchor that is not in the page.
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
  }
}

/**
 * ExportButton — "Export" as a download: builds a file in the browser and hands it to the browser
 * (the shape of inventory-ui's `ExportYearButton`, now shared). The button is `aria-busy`, never
 * `disabled` (which would drop keyboard focus), while it builds, and a second click is ignored; a
 * polite status line says "preparing" then "ready"; a failure is an inline alert and the button is
 * usable again. Place it next to the list or figures it exports; the app's `build` decides what
 * goes in the file and how it is named.
 */
export function ExportButton({
  label,
  build,
  messages,
  mimeType = XLSX_MIME,
  resetKey,
  variant = 'secondary',
  testId,
}: ExportButtonProps) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  // The line describes the export of one `resetKey`; a new key starts clean.
  const [seenKey, setSeenKey] = useState(resetKey)
  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setOutcome(null)
  }

  // Read when a build finishes, to tell whether the key moved on while it ran.
  const keyRef = useRef(resetKey)
  const running = useRef(false)
  useEffect(() => {
    keyRef.current = resetKey
  })

  const run = async () => {
    if (running.current) return
    running.current = true
    const forKey = resetKey
    setBusy(true)
    setOutcome(null)
    let result: Outcome
    try {
      const built = await build()
      download(built.data, built.fileName, mimeType)
      result = { forKey, kind: 'ready', message: built.readyMessage || messages.ready }
    } catch {
      result = { forKey, kind: 'failed' }
    }
    running.current = false
    setBusy(false)
    if (keyRef.current === forKey) setOutcome(result)
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} busy={busy} onClick={() => void run()} data-testid={testId}>
        {label}
      </Button>
      <p role="status" className="text-xs text-soft" data-testid={`${testId}-status`}>
        {busy ? messages.busy : outcome?.kind === 'ready' ? outcome.message : ''}
      </p>
      {outcome?.kind === 'failed' && (
        <p role="alert" className="text-xs text-org-text" data-testid={`${testId}-error`}>
          {messages.failed}
        </p>
      )}
    </div>
  )
}

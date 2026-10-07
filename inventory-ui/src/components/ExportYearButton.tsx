import { useRef, useState } from 'react'
import type { FiscalYearView } from '../lib/types'
import { strings } from '../strings'

/**
 * ExportYearButton — "Export XLSX" on the year detail page (T38 stub, filled by
 * T39; specs/015-hardware-inventory; design.md F12 step 5, § Accessibility "T6
 * year detail"; AC-8.8, AC-8.9). The props are the T38 contract: the
 * `FiscalYearView` being shown, which is everything the export needs.
 *
 * Click builds the workbook in the browser and hands it to the browser as a
 * download. `lib/yearWorkbook` (and with it the heavy `exceljs`) is loaded with a
 * dynamic `import()` on first click, so it is a lazy chunk and never part of the
 * page. While building the button is `aria-busy` (not `disabled`, which would drop
 * keyboard focus) and a second click is ignored; a polite status line says
 * "Preparing file…" then "File ready"; a failure (build, or the browser refusing
 * the object URL) is an inline alert and the control is usable again. An OPEN
 * year exports provisional, in the sheet and in the file name (the builder owns
 * that). A status line is tied to the year's status it was made for, so a "File
 * ready" for the provisional file does not linger once the year is closed.
 */

export type ExportYearButtonProps = {
  view: FiscalYearView
}

type Phase = 'idle' | 'busy' | 'ready' | 'failed'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const download = (data: BlobPart, fileName: string): void => {
  const url = URL.createObjectURL(new Blob([data], { type: XLSX_MIME }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export default function ExportYearButton({ view }: ExportYearButtonProps) {
  const t = strings.yearDetail.export
  const [state, setState] = useState<{ phase: Phase; forStatus: FiscalYearView['status'] }>({
    phase: 'idle',
    forStatus: view.status,
  })
  const running = useRef(false)
  const phase = state.forStatus === view.status ? state.phase : 'idle'

  const run = async () => {
    if (running.current) return
    running.current = true
    const forStatus = view.status
    setState({ phase: 'busy', forStatus })
    try {
      const { buildYearWorkbook, yearWorkbookFileName } = await import('../lib/yearWorkbook')
      const buffer = await buildYearWorkbook(view).xlsx.writeBuffer()
      download(buffer, yearWorkbookFileName(view))
      setState({ phase: 'ready', forStatus })
    } catch {
      setState({ phase: 'failed', forStatus })
    } finally {
      running.current = false
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        aria-busy={phase === 'busy' ? true : undefined}
        onClick={() => void run()}
        data-testid="export-year-button"
        className="border px-3 py-2 text-sm font-medium aria-busy:opacity-60"
        style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
      >
        {t.button}
      </button>
      <p role="status" className="text-xs" style={{ color: 'var(--soft)' }}>
        {phase === 'busy' ? t.preparing : phase === 'ready' ? t.ready : ''}
      </p>
      {phase === 'failed' && (
        <p role="alert" className="text-xs" style={{ color: 'var(--org)' }}>
          {t.failed}
        </p>
      )}
    </div>
  )
}

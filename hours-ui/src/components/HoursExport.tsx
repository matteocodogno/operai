import { ExportButton } from '@operai/ui'
import { isCode } from '../lib/errors'
import { readAllEntries } from '../lib/exportPages'
import type { EntryFilters } from '../lib/hoursApi'
import { strings } from '../strings'

export type HoursExportProps = {
  /**
   * What the view applies, whose hours included: the export asks for exactly the entries these filters match
   * (A11) and is named from their period. They are read when the person clicks, so the file is of what the
   * filters are then.
   */
  filters: EntryFilters
  /** Changes when the filters do: a "File ready" line describes the file of the filters it was made for. */
  resetKey: string
  /**
   * Under a deal filter, or a project filter, the walk was refused with 503 `host_unavailable` — Meetings cannot say
   * which meetings are linked to the deal (AC-4.11) or to the project (specs/20261112-project-hours AC-4.8). The
   * export shows no alert of its own for it: the page switches to its one "deal filter unavailable" or "project
   * filter unavailable" state, which also takes this button out, so nothing is downloaded and nothing partial is
   * written. With both filters set it is told once; the page decides which words show.
   */
  onFilterUnavailable?: () => void
}

/**
 * HoursExport — the Export button of My hours and Everyone's hours (specs/20261112-time-tracking T30; design F5;
 * AC-4.6, AC-4.7, AC-4.10, AC-4.11; the project filter's refusal, specs/20261112-project-hours AC-4.8): `@operai/ui`'s
 * `ExportButton` with the app's `build`.
 *
 * `build` runs on the click. It walks EVERY page of `GET /time-entries` with the view's filters (`exportPages`),
 * then loads the spreadsheet library — `lib/hoursWorkbook` and, with it, `exceljs`, by a dynamic `import()` made
 * here and nowhere else, so none of it is in the page's bundle — and builds the file from the entries
 * (`buildHoursWorkbook`). If any page said a source did not answer (AC-4.7) the file is still made and the ready
 * line says names are missing. A failed page or build is the button's one alert and nothing is downloaded; the
 * single exception is the host-filter refusal above.
 *
 * The file holds only what the viewer may read: the builder writes a name only for `visibility: "visible"`, and
 * never an id (AC-4.10). A walk is not stopped when the button goes away: like any build in the library's button,
 * it finishes and hands the file over.
 */
export default function HoursExport({ filters, resetKey, onFilterUnavailable }: HoursExportProps) {
  const t = strings.export

  const build = async () => {
    const read = await readAllEntries(filters).catch((error: unknown): never => {
      const underHostFilter = filters.dealId !== undefined || filters.projectId !== undefined
      if (underHostFilter && isCode(error, 'host_unavailable')) onFilterUnavailable?.()
      throw error
    })
    const { buildHoursWorkbook, hoursFileName, workbookCopyOf } = await import('../lib/hoursWorkbook')
    const workbook = buildHoursWorkbook(read.items, workbookCopyOf(strings))
    return {
      data: await workbook.xlsx.writeBuffer(),
      fileName: hoursFileName(filters.from, filters.to),
      readyMessage: read.unavailable.length > 0 ? t.readyNamesMissing : undefined,
    }
  }

  return (
    <ExportButton
      label={t.button}
      build={build}
      messages={{ busy: t.busy, ready: t.ready, failed: t.failed }}
      resetKey={resetKey}
      testId="hours-export"
    />
  )
}

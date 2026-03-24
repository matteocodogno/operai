import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import Header from './components/Header'
import MetricsBar from './components/MetricsBar'
import ActivityTable from './components/ActivityTable'
import SummaryTable from './components/SummaryTable'
import ParametersPanel from './components/ParametersPanel'
import { pertCalc } from './hooks/useEstimator'
import { useEstimatorContext } from './context/EstimatorContext'
import type { ProjectData } from './lib/projects'
import { buildShareUrl } from './lib/shareUrl'
import { exportPdf } from './lib/pdfExport'
import { renderGanttPng } from './lib/ganttChart'
import { computeActivityNums } from './lib/activityNums'
import { computeHealthWarnings } from './lib/healthWarnings'
import ShortcutsModal from './components/ShortcutsModal'
import HealthWarningsModal from './components/HealthWarningsModal'
import QrModal from './components/QrModal'
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from "@vercel/speed-insights/react"

export default function EstimatorApp() {
  const [tab, setTab] = useState<'activities' | 'summary' | 'parameters'>('activities')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showHealthWarnings, setShowHealthWarnings] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const shareCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.shiftKey && e.key === '?') { e.preventDefault(); setShowShortcuts(v => !v) }
      if (e.shiftKey && e.key === 'H') { e.preventDefault(); setShowHealthWarnings(v => !v) }
      if (e.shiftKey && e.key === 'Q') { e.preventDefault(); setShowQr(v => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const {
    projectId, name, author, params, releases, acts,
    summary, totals, byProfile,
    saveStatus,
    setName, setAuthor,
    updAct, addAct, delAct, reorderActs,
    updRel, addRel, delRel,
    updP,
  } = useEstimatorContext()

  const rnames = useMemo(() => releases.map(r => r.name), [releases])

  const warnings = useMemo(
    () => computeHealthWarnings(acts, releases, summary),
    [acts, releases, summary]
  )

  const exportXLSX = useCallback(() => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Parameter', 'Value'], ['Project', name], ['Author', author], ['Date', new Date().toLocaleDateString()], [],
      ['Parallelism factor', params.parallelism], ['Sprint duration (days)', params.sprintDays],
      ['Working days / month', params.workingDaysMonth], ['QA Deploy per release', params.qaDeployDays],
      ['QA Test per release', params.qaTestDays], ['PM overhead per release', params.pmDays],
    ]), 'Parameters')
    const nums = computeActivityNums(acts)
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['#', 'Epic', 'Activity', 'Profile', 'Optimistic', 'Most Likely', 'Pessimistic', 'PERT', 'Risk Buffer', 'Expected', 'AI Gain %', 'Notes', 'Release'],
      ...acts.map(a => {
        const pv = pertCalc(a.o, a.ml, a.p)
        const actGain = (a.aiGain !== undefined && a.aiGain !== null && (a.aiGain as unknown as string) !== '')
          ? Number(a.aiGain)
          : params.aiGain
        return [nums.get(a.id) ?? '', a.epic, a.act, a.prof, +a.o, +a.ml, +a.p, +pv.toFixed(1), +a.risk, +(pv + (Number(a.risk) || 0)).toFixed(1), Math.round(actGain * 100), a.notes, a.release]
      }),
    ]), 'Detail')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Release', 'FTE', 'Ind. M/D', 'Planning', 'Baseline', 'Elapsed Days', 'Total M/D', 'Months', 'Best', 'Worst', 'Range', 'AI Cost', 'AI-assisted Elapsed', 'Total M/D (AI)'],
      ...summary.map(s => s.res
        ? [s.name, s.fte, s.res.ind, s.res.plan, s.res.base, s.res.el, s.res.tm, s.res.mo, s.res.best, s.res.worst, `${s.res.best}–${s.res.worst} days`, s.res.aiCost, s.res.aiElapsed, s.res.aiTotalMD]
        : [s.name, s.fte, ...Array(12).fill('—')],
      ),
      ['TOTAL', '', totals.ind.toFixed(1), '', totals.base.toFixed(1), totals.el, totals.tm, totals.mo, totals.best, totals.worst, `${totals.best}–${totals.worst} days`, totals.aiCost, totals.aiElapsed, totals.aiTotalMD],
    ]), 'Summary')
    XLSX.writeFile(wb, `${name.replace(/\s+/g, '_')}_estimate.xlsx`)
  }, [acts, summary, totals, params, name, author])

  const exportClient = useCallback(async () => {
    const wdm = params.workingDaysMonth || 20
    const active = summary.filter(s => s.res)

    const wb  = new ExcelJS.Workbook()
    wb.creator = author || 'EstimAI'
    wb.created = new Date()
    const ws  = wb.addWorksheet('Estimate')

    // ── Table ──────────────────────────────────────────────────────────
    ws.columns = [
      { header: 'Release',              key: 'release', width: 22 },
      { header: 'Duration (months)',    key: 'mo',      width: 18 },
      { header: 'Best case (months)',   key: 'best',    width: 18 },
      { header: 'Worst case (months)',  key: 'worst',   width: 18 },
      { header: 'Effort (man-days)',    key: 'tm',      width: 18 },
    ]

    // Style header row
    const headerRow = ws.getRow(1)
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B6AF7' } }
      cell.alignment = { horizontal: 'center' }
    })

    for (const s of active) {
      const res = s.res!
      ws.addRow({
        release: s.name,
        mo:      +res.mo.toFixed(1),
        best:    +(res.best / wdm).toFixed(1),
        worst:   +(res.worst / wdm).toFixed(1),
        tm:      res.tm,
      })
    }

    // Totals row
    const totalRow = ws.addRow({
      release: 'TOTAL',
      mo:      +totals.mo.toFixed(1),
      best:    +(totals.best / wdm).toFixed(1),
      worst:   +(totals.worst / wdm).toFixed(1),
      tm:      totals.tm,
    })
    totalRow.eachCell(cell => { cell.font = { bold: true } })

    // Zebra stripes on data rows
    ws.eachRow((row, rowNumber) => {
      if (rowNumber < 2) return
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center' }
        if (rowNumber % 2 === 0 && rowNumber !== ws.rowCount) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0FF' } }
        }
      })
    })

    // ── Gantt chart image ──────────────────────────────────────────────
    const png = renderGanttPng(summary, wdm)
    if (png) {
      const chartRows  = active.length
      const chartH     = 52 + chartRows * 48 + 28   // must match ganttChart.ts layout
      const chartW     = 668                          // (16+120+500+32) logical px

      const imgId = wb.addImage({ base64: png, extension: 'png' })
      const tableRows = active.length + 2            // header + data + totals
      ws.addImage(imgId, {
        tl:  { col: 0, row: tableRows + 1 } as ExcelJS.Anchor,
        ext: { width: chartW, height: chartH },
      })
      // Reserve rows for the image so the sheet scrolls correctly
      const imgRowCount = Math.ceil(chartH / 20) + 1
      for (let r = 0; r < imgRowCount; r++) ws.addRow({})
    }

    // ── Download ───────────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer()
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement('a')
    a.href       = url
    a.download   = `${name.replace(/\s+/g, '_') || 'estimate'}_client.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }, [summary, totals, params, name, author])

const exportPDF = useCallback(() => {
    const data = { id: projectId, name, author, params, releases, acts }
    const shareUrl = buildShareUrl(data)
    exportPdf({ name, author, summary, totals, params, shareUrl })
  }, [projectId, name, author, params, releases, acts, summary, totals])

  const handleShare = useCallback(() => {
    const data: ProjectData = { id: projectId, name, author, params, releases, acts }
    const url = buildShareUrl(data)
    navigator.clipboard.writeText(url).then(() => {
      setShareCopied(true)
      if (shareCopiedTimer.current) clearTimeout(shareCopiedTimer.current)
      shareCopiedTimer.current = setTimeout(() => setShareCopied(false), 2000)
    })
  }, [projectId, name, author, params, releases, acts])

  return (
    <div className="min-h-full w-full">
      <Header
        name={name}
        author={author}
        saveStatus={saveStatus}
        onNameChange={setName}
        onAuthorChange={setAuthor}
      />

      <MetricsBar
        totals={totals}
        activityCount={acts.length}
        releaseCount={releases.length}
        profileCount={byProfile.length}
      />

      <div className="flex items-end gap-px px-5.5 pt-2.5 pb-0 border-b border-rule bg-ink-soft">
        {([
          ['activities', 'Activities', warnings.activityCount],
          ['summary',    'Summary',    warnings.releaseCount],
          ['parameters', 'Parameters', 0],
        ] as const).map(([k, l, warnCount]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`py-1.75 px-3.5 rounded-t-md rounded-b-none transition-all flex items-center gap-1.5 ${
              tab === k
                ? 'bg-acc text-white font-medium border-b-2 border-acc'
                : 'bg-transparent text-muted font-normal border-b-2 border-transparent'
            }`}
          >
            {l}
            {warnCount > 0 && (
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold leading-none ${
                tab === k ? 'bg-white/20 text-white' : 'bg-org/20 text-org'
              }`}>
                {warnCount}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-1 mb-1">
          <button
            onClick={handleShare}
            className="py-1 px-2.5 text-[11px] font-medium text-acc border border-acc/30 hover:border-acc hover:bg-acc/5 transition-colors flex items-center gap-1"
            title="Copy shareable link to clipboard"
          >
            <span>{shareCopied ? '✓' : '⤴'}</span> {shareCopied ? 'Copied!' : 'Share'}
          </button>
          <div className="w-px h-4 bg-rule mx-0.5" />
          <button
            onClick={exportClient}
            className="py-1 px-2.5 text-[11px] font-medium text-acc-hi border border-acc/30 hover:border-acc hover:text-acc transition-colors flex items-center gap-1"
            title="Clean export for the client — no internal details"
          >
            <span>↓</span> Client
          </button>
          <button
            onClick={exportPDF}
            className="py-1 px-2.5 text-[11px] font-medium text-muted border border-rule hover:text-text hover:border-text/40 transition-colors flex items-center gap-1"
            title="Export PDF with summary, Gantt, and QR code"
          >
            <span>↓</span> PDF
          </button>
          <div className="w-px h-4 bg-rule mx-0.5" />
          <button
            onClick={exportXLSX}
            className="py-1 px-2.5 text-[11px] font-medium text-muted border border-rule hover:text-text hover:border-text/40 transition-colors flex items-center gap-1"
          >
            <span>↓</span> Excel
          </button>
        </div>
      </div>

      <main className="flex-1 p-5 px-5.5 overflow-x-auto">
        {tab === 'activities' && (
          <ActivityTable
            activities={acts}
            releaseNames={rnames}
            globalAiGain={params.aiGain}
            activityWarnings={warnings.activityWarnings}
            onUpdate={updAct}
            onDelete={delAct}
            onAdd={addAct}
            onAddRelease={addRel}
            onReorder={reorderActs}
          />
        )}
        {tab === 'summary' && (
          <SummaryTable
            summary={summary}
            releases={releases}
            totals={totals}
            byProfile={byProfile}
            releaseWarnings={warnings.releaseWarnings}
            onUpdateRelease={updRel}
            onAddRelease={addRel}
            onDeleteRelease={delRel}
          />
        )}
        {tab === 'parameters' && (
          <ParametersPanel params={params} onUpdate={updP} />
        )}
      </main>

      {/* Fixed footer */}
      <footer className="fixed bottom-0 right-0 z-10 px-4 py-2 pointer-events-none">
        <button
          onClick={() => setShowShortcuts(v => !v)}
          className="pointer-events-auto flex items-center gap-1.5 text-[11px] text-muted hover:text-soft transition-colors font-mono"
          title="Keyboard shortcuts (Shift+?)"
        >
          <kbd className="inline-flex items-center px-1 py-0.5 rounded border border-rule bg-ink-mid text-[10px] leading-none">⇧?</kbd>
          <span>shortcuts</span>
        </button>
      </footer>

      {showHealthWarnings && (
        <HealthWarningsModal
          activityWarnings={warnings.activityWarnings}
          releaseWarnings={warnings.releaseWarnings}
          activities={acts}
          releases={releases}
          onClose={() => setShowHealthWarnings(false)}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showQr && (
        <QrModal
          shareUrl={buildShareUrl({ id: projectId, name, author, params, releases, acts })}
          projectName={name}
          onClose={() => setShowQr(false)}
        />
      )}

      <Analytics />
      <SpeedInsights />
    </div>
  )
}

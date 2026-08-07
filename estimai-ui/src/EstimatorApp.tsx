import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { useNavigate, useRouter } from '@tanstack/react-router'
import Header from './components/Header'
import { authClient } from './lib/authClient'
import MetricsBar from './components/MetricsBar'
import ActivityTable from './components/ActivityTable'
import SummaryTable from './components/SummaryTable'
import ParametersPanel from './components/ParametersPanel'
import { pertCalc } from './hooks/useEstimator'
import { SAVED_TOAST_MESSAGE, useEstimatorContext } from './context/EstimatorContext'
import { strings } from './strings'
import type { ProjectData } from './lib/projects'
import { buildShareUrl } from './lib/shareUrl'
import { exportPdf } from './lib/pdfExport'
import { renderGanttPng } from './lib/ganttChart'
import { svgToDataUrl } from './lib/logoUtils'
import { computeActivityNums } from './lib/activityNums'
import { computeHealthWarnings } from './lib/healthWarnings'
import ShortcutsModal from './components/ShortcutsModal'
import HealthWarningsModal from './components/HealthWarningsModal'
import QrModal from './components/QrModal'
import TemplatePicker from './components/TemplatePicker'
import HelpDrawer from './components/HelpDrawer'
import ToastBanner from './components/ToastBanner'
import ConflictBanner from './components/ConflictBanner'
import CollaboratorsDialog from './components/CollaboratorsDialog'
import { formatIdentity } from './lib/identity'
import * as estimatesApi from './lib/estimatesApi'
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from "@vercel/speed-insights/react"

/**
 * T22 (specs/013-estimate-sharing/tasks.md; design.md "## Toolbar
 * composition decision"): tiny local label helper for the "Shared by
 * {owner} · {level}" chip. Mirrors `CollaboratorsDialog.tsx`'s own private
 * `levelLabel` — duplicated here rather than exported from that
 * already-merged, self-contained file for a single two-line helper.
 */
function accessLevelLabel(level: 'editor' | 'viewer'): string {
  return level === 'editor' ? strings.sharing.dialog.levelEditor : strings.sharing.dialog.levelViewer
}

export default function EstimatorApp() {
  // The suite-level chrome (logo/About, avatar menu + sign-out, theme toggle)
  // is now owned by the shell (specs/003-suite-shell, T6/T9/T14) — it is not
  // rendered here. `authClient.useSession()` is still read below, but only to
  // source the author-backfill value; `shell/session` (via T13's authClient
  // facade) is what actually supplies the session.
  const { data: session } = authClient.useSession()
  const sessionUser = session?.user ?? null
  const navigate = useNavigate()
  const router = useRouter()

  const [tab, setTab] = useState<'activities' | 'summary' | 'parameters'>('activities')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showHealthWarnings, setShowHealthWarnings] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showCollaborators, setShowCollaborators] = useState(false)
  const [dismissedPicker, setDismissedPicker] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const shareCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
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
    saveStatus, saveError, clearSaveError, showSavedToast, dismissSavedToast,
    setName, setAuthor,
    updAct, addAct, delAct, reorderActs,
    updRel, addRel, delRel,
    updP, loadTemplate,
    canEdit, conflict,
    access, owner, collaboratorCount,
  } = useEstimatorContext()

  // T17 (specs/013-estimate-sharing/tasks.md; design.md S5 "single canEdit
  // gate"): the ONE place this component derives readOnly — every child
  // below reads this same value, never re-deriving `canEdit` itself (plan
  // risk R5).
  const readOnly = !canEdit

  // T18 (specs/013-estimate-sharing/tasks.md; design.md S4) — the two
  // ConflictBanner actions.
  //
  // "Reload latest": a route invalidate re-runs the current route's loader
  // (estimatesApi.get), which returns a fresh `version` — EstimatePage.tsx's
  // `providerKey={estimate.version}` then remounts a brand-new
  // EstimatorProvider on that key, discarding only what was superseded.
  const handleReloadLatest = useCallback(() => {
    void router.invalidate()
  }, [router])

  // "Save as a copy instead": POST /estimates of the CURRENT local content
  // (the in-progress edits the conflict never touched, AC-4.2) — a zero-API-
  // cost escape hatch that never risks the server's refusal again, since it
  // creates a brand-new estimate rather than retrying the guarded PUT.
  const handleSaveAsCopy = useCallback(() => {
    void estimatesApi
      .create({ name, author, content: { params, releases, acts } })
      .then((created) => {
        navigate({ to: '/estimates/$estimateId', params: { estimateId: created.id } })
      })
      .catch((err: unknown) => {
        // No designed inline failure state for this escape hatch (design.md
        // leaves it unspecified) — the ConflictBanner simply stays up so the
        // user can retry either action; logged so a real failure isn't
        // silently invisible.
        console.error('Save as a copy failed:', err)
      })
  }, [name, author, params, releases, acts, navigate])

  // The author is the logged-in user — there is no manual author input anymore.
  // Backfill it from the session for estimates created without one (e.g. new or
  // imported), without overwriting an author already recorded on the estimate.
  useEffect(() => {
    if (author) return
    const sessionAuthor = sessionUser?.name || sessionUser?.email
    if (sessionAuthor) setAuthor(sessionAuthor)
  }, [author, sessionUser, setAuthor])

  const rnames = useMemo(() => releases.map(r => r.name), [releases])

  const handleDeleteRelease = useCallback((id: string) => {
    const rel = releases.find(r => r.id === id)
    const count = acts.filter(a => a.release === rel?.name).length
    const label = rel?.name || 'this release'
    const msg = count > 0
      ? `Delete "${label}" and its ${count} ${count === 1 ? 'activity' : 'activities'}?`
      : `Delete "${label}"?`
    if (!confirm(msg)) return
    delRel(id)
  }, [releases, acts, delRel])

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

    // ── Column widths ──────────────────────────────────────────────────
    ws.columns = [
      { key: 'release', width: 22 },
      { key: 'mo',      width: 18 },
      { key: 'best',    width: 18 },
      { key: 'worst',   width: 18 },
      { key: 'tm',      width: 18 },
    ]

    // ── Logo + project info (rows 1-2) ─────────────────────────────────
    ws.getRow(1).height = 36
    ws.getRow(2).height = 8  // spacer

    const logoDataUrl = await svgToDataUrl('/estimai-light.svg', 128)
    const logoImgId = wb.addImage({ base64: logoDataUrl.split(',')[1], extension: 'png' })
    ws.addImage(logoImgId, {
      tl: { col: 0, row: 0 } as ExcelJS.Anchor,
      ext: { width: 32, height: 32 },
      editAs: 'absolute',
    })

    const nameCell = ws.getCell('B1')
    nameCell.value = name || 'Untitled'
    nameCell.font = { bold: true, size: 12 }
    nameCell.alignment = { vertical: 'middle' }

    if (author) {
      const authorCell = ws.getCell('C1')
      authorCell.value = author
      authorCell.font = { size: 9, color: { argb: 'FF888888' } }
      authorCell.alignment = { vertical: 'middle' }
    }

    const dateCell = ws.getCell('E1')
    dateCell.value = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    dateCell.alignment = { horizontal: 'right', vertical: 'middle' }
    dateCell.font = { size: 9, color: { argb: 'FF888888' } }

    // ── Table header (row 3) ───────────────────────────────────────────
    const TABLE_HEADERS = ['Release', 'Duration (months)', 'Best case (months)', 'Worst case (months)', 'Effort (man-days)']
    const headerRow = ws.getRow(3)
    TABLE_HEADERS.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1)
      cell.value = h
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B6AF7' } }
      cell.alignment = { horizontal: 'center' }
    })

    // ── Data rows (row 4+) ─────────────────────────────────────────────
    let nextRow = 4
    for (const s of active) {
      const res = s.res!
      const row = ws.getRow(nextRow)
      const vals = [s.name, +res.mo.toFixed(1), +(res.best / wdm).toFixed(1), +(res.worst / wdm).toFixed(1), res.tm]
      vals.forEach((v, i) => {
        const cell = row.getCell(i + 1)
        cell.value = v
        cell.alignment = { horizontal: 'center' }
        if (nextRow % 2 === 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0FF' } }
        }
      })
      nextRow++
    }

    // ── Total row ──────────────────────────────────────────────────────
    const totalRow = ws.getRow(nextRow)
    const totalVals = ['TOTAL', +totals.mo.toFixed(1), +(totals.best / wdm).toFixed(1), +(totals.worst / wdm).toFixed(1), totals.tm]
    totalVals.forEach((v, i) => {
      const cell = totalRow.getCell(i + 1)
      cell.value = v
      cell.font = { bold: true }
      cell.alignment = { horizontal: 'center' }
    })
    nextRow++

    // ── Gantt chart image ──────────────────────────────────────────────
    const png = renderGanttPng(summary, wdm)
    if (png) {
      const chartRows  = active.length
      const chartH     = 52 + chartRows * 48 + 28   // must match ganttChart.ts layout
      const chartW     = 668                          // (16+120+500+32) logical px

      const imgId = wb.addImage({ base64: png, extension: 'png' })
      ws.addImage(imgId, {
        tl:  { col: 0, row: nextRow + 1 } as ExcelJS.Anchor,
        ext: { width: chartW, height: chartH },
      })
      // Reserve rows for the image so the sheet scrolls correctly
      const imgRowCount = Math.ceil(chartH / 20) + 1
      for (let r = 0; r < imgRowCount; r++) ws.getRow(nextRow + 1 + r)
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
    exportPdf({ name, author, acts, summary, totals, params, shareUrl })
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
        saveStatus={saveStatus}
        onNameChange={setName}
        readOnly={readOnly}
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
            <span>{shareCopied ? '✓' : '⤴'}</span>{' '}
            {shareCopied ? strings.sharing.toolbar.shareLinkCopied : strings.sharing.toolbar.shareLink}
          </button>
          <div className="w-px h-4 bg-rule mx-0.5" />
          {/* T22 (specs/013-estimate-sharing/tasks.md; design.md "## Toolbar
              composition decision"): a SECOND, differently-shaped entry —
              never folded into "Share link" above (AC-8.1/AC-8.2). Owner
              sees an actionable button that opens CollaboratorsDialog in
              owner mode; a collaborator sees a non-actionable-looking chip
              that opens the same dialog in its read-only member mode. */}
          {access === 'owner' ? (
            <button
              onClick={() => setShowCollaborators(true)}
              className="py-1 px-2.5 text-[11px] font-medium text-muted border border-rule hover:text-text hover:border-text/40 transition-colors flex items-center gap-1"
              title="Manage collaborators"
              aria-label={
                collaboratorCount
                  ? strings.sharing.toolbar.collaboratorsWithCount(collaboratorCount)
                  : undefined
              }
              data-testid="collaborators-button"
            >
              <span aria-hidden="true">👥</span> {strings.sharing.toolbar.collaborators}
              {!!collaboratorCount && (
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold leading-none bg-muted/20 text-muted"
                >
                  {collaboratorCount}
                </span>
              )}
            </button>
          ) : (
            <button
              onClick={() => setShowCollaborators(true)}
              className="py-1 px-2.5 text-[11px] font-medium text-muted border border-rule rounded-full hover:text-text hover:border-text/40 transition-colors flex items-center gap-1"
              title="View collaboration details"
              data-testid="collaborators-chip"
            >
              {strings.sharing.toolbar.sharedByChip(
                formatIdentity(owner ?? { status: 'unknown', name: null }),
                accessLevelLabel(access),
              )}
            </button>
          )}
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
          <div className="w-px h-4 bg-rule mx-0.5" />
          <button
            onClick={() => setShowHelp(v => !v)}
            className={`w-6 h-6 rounded-full text-[11px] font-bold border transition-colors flex items-center justify-center ${
              showHelp
                ? 'border-acc bg-acc/10 text-acc'
                : 'border-rule text-muted hover:border-acc/50 hover:text-acc'
            }`}
            title="Model reference"
            aria-label="Model reference"
          >
            ?
          </button>
        </div>
      </div>

      {/* T18 (design.md S4): the ConflictBanner owns this zone EXCLUSIVELY
          while a conflict is active — it never stacks with the ordinary
          save toast (EstimatorContext.tsx already clears saveError/
          showSavedToast the moment it enters `conflict`, but the explicit
          branch here makes that exclusivity a render-time guarantee too). */}
      {conflict ? (
        <ConflictBanner conflict={conflict} onReloadLatest={handleReloadLatest} onSaveAsCopy={handleSaveAsCopy} />
      ) : (
        <>
          {saveError && <ToastBanner message={saveError} onDismiss={clearSaveError} />}
          {!saveError && showSavedToast && (
            <ToastBanner tone="success" message={SAVED_TOAST_MESSAGE} onDismiss={dismissSavedToast} />
          )}
        </>
      )}

      <main className="flex-1 p-5 px-5.5 overflow-x-auto">
        {tab === 'activities' && (
          acts.length === 0 && !canEdit
            // T17 (design.md S5): TemplatePicker's whole contract is content
            // creation — the wrong verb for a viewer. A small inline state
            // replaces it; no call to action, because there is none
            // available to a viewer.
            ? <div className="flex flex-col items-center px-5.5 py-12 gap-8">
                <p className="text-muted text-sm">{strings.sharing.emptyActivitiesViewer}</p>
              </div>
            : acts.length === 0 && !dismissedPicker
              ? <TemplatePicker
                  onSelect={t => { loadTemplate(t); setDismissedPicker(true) }}
                  onBlank={() => setDismissedPicker(true)}
                />
              : <ActivityTable
                  activities={acts}
                  releaseNames={rnames}
                  globalAiGain={params.aiGain}
                  activityWarnings={warnings.activityWarnings}
                  onUpdate={updAct}
                  onDelete={delAct}
                  onAdd={addAct}
                  onAddRelease={addRel}
                  onReorder={reorderActs}
                  readOnly={readOnly}
                />
        )}
        {tab === 'summary' && (
          <SummaryTable
            summary={summary}
            releases={releases}
            totals={totals}
            byProfile={byProfile}
            params={params}
            releaseWarnings={warnings.releaseWarnings}
            onUpdateRelease={updRel}
            onAddRelease={addRel}
            onDeleteRelease={handleDeleteRelease}
            readOnly={readOnly}
          />
        )}
        {tab === 'parameters' && (
          <ParametersPanel params={params} onUpdate={updP} readOnly={readOnly} />
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
      {showHelp && <HelpDrawer onClose={() => setShowHelp(false)} />}
      {showQr && (
        <QrModal
          shareUrl={buildShareUrl({ id: projectId, name, author, params, releases, acts })}
          projectName={name}
          onClose={() => setShowQr(false)}
        />
      )}
      {showCollaborators && (
        <CollaboratorsDialog
          estimateId={projectId}
          access={access}
          owner={owner}
          onClose={() => setShowCollaborators(false)}
        />
      )}

      <Analytics />
      <SpeedInsights />
    </div>
  )
}

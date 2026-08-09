import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ReleaseSummary, Totals, Parameters, Activity } from '../types'
import { renderGanttPng } from './ganttChart'
import { svgToDataUrl } from './logoUtils'

// ── A4 layout constants (mm) ──────────────────────────────────────────────────
const PAGE_W = 210
const PAGE_H = 297
const ML = 14
const MR = 14
const CW = PAGE_W - ML - MR

// ── Brand palette ─────────────────────────────────────────────────────────────
const NAVY  = '#1e1e3a'   // table header background
const HDR   = '#0d0d14'   // page header background (app --ink)
const ACC   = '#8b96ff'   // accent purple
const BORDER_ACC = '#5b6af7' // header bottom border
const SOFT  = '#8888aa'   // muted text in header (app --soft)
const GRN   = '#2ec27e'
const ORG   = '#f5a623'
const MUTED = '#7878a8'
const RULE  = '#dcdcec'
const ALT   = '#f5f5fc'
const THD   = '#eaeaf6'
const INK   = '#1a1a2e'

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

/** Derive PERT from three estimates (handles ML-only by deriving O and P). */
function pertLocal(o: number | string, ml: number | string, p: number | string): number {
  const M = +ml || 0
  const O = +o  || M * 0.75
  const P = +p  || M * 1.60
  return (O + 4 * M + P) / 6
}

export interface ExportPdfOptions {
  name: string
  author: string
  acts: Activity[]
  summary: ReleaseSummary[]
  totals: Totals
  params: Parameters
}

export async function exportPdf({
  name, author, acts, summary, totals, params,
}: ExportPdfOptions): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })

  // ── Async assets (logo) ───────────────────────────────────────────────────
  // A "Scan to view online" QR used to sit bottom-right, encoding the anonymous
  // share link. That link mechanism was removed on 2026-08-09 (see specs/013's
  // US-8 amendment); with no account-free view to point at, the QR went too.
  const logoDataUrl = await svgToDataUrl('/estimai-light.svg', 256)

  // ── Section heading helper ────────────────────────────────────────────────
  // 4 px accent bar + uppercase bold label at full document ink
  function secHeading(y: number, title: string): void {
    doc.setFillColor(BORDER_ACC)
    doc.rect(ML, y - 3, 4, 7, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(HDR)
    doc.text(title, ML + 7, y + 1.2)
  }

  // ── Header strip ─────────────────────────────────────────────────────────
  const HDR_H = 24
  doc.setFillColor(HDR)
  doc.rect(0, 0, PAGE_W, HDR_H, 'F')

  // 3 px accent line at the bottom of the header
  doc.setFillColor(BORDER_ACC)
  doc.rect(0, HDR_H, PAGE_W, 0.8, 'F')

  // Logo mark (16 × 16 mm) + "EstimAI" wordmark
  const LOGO_MM = 16
  const LOGO_Y = (HDR_H - LOGO_MM) / 2
  doc.addImage(logoDataUrl, 'PNG', ML, LOGO_Y, LOGO_MM, LOGO_MM)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor('#ffffff')
  doc.text('EstimAI', ML + LOGO_MM + 2.5, 15)

  // Project name centred (weight 600 ≈ bold in PDF)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor('#ffffff')
  doc.text(name || 'Untitled', PAGE_W / 2 + 12, 15, { align: 'center', maxWidth: 90 })

  // Author + date (right-aligned, stacked, muted)
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(SOFT)
  if (author) doc.text(author, PAGE_W - MR, 10.5, { align: 'right' })
  doc.text(`Estimate date: ${dateStr}`, PAGE_W - MR, 17, { align: 'right' })

  // ── KPI strip ─────────────────────────────────────────────────────────────
  const kpis: { label: string; value: string; color: string }[] = [
    { label: 'Total Elapsed', value: `${totals.el} d`,                  color: ACC },
    { label: 'Man-days',      value: `${totals.tm}`,                    color: ACC },
    { label: 'Duration',      value: `${totals.mo.toFixed(1)} mo`,      color: GRN },
    { label: 'Range',         value: `${totals.best}–${totals.worst} d`, color: ORG },
  ]
  const kpiW = CW / kpis.length
  kpis.forEach(({ label, value, color }, i) => {
    const cx = ML + i * kpiW + kpiW / 2
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(color)
    doc.text(value, cx, 34, { align: 'center' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor('#4a4a62')
    doc.text(label.toUpperCase(), cx, 39.5, { align: 'center' })
  })

  doc.setDrawColor(RULE)
  doc.setLineWidth(0.25)
  doc.line(ML, 43.5, PAGE_W - MR, 43.5)

  // ── Release summary ───────────────────────────────────────────────────────
  secHeading(48, 'RELEASE SUMMARY')

  const bodyRows: string[][] = summary.map(s => {
    if (!s.res) return [s.name, String(s.fte), '—', '—', '—', '—', '—', '—']
    const { el, tm, mo, best, worst } = s.res
    return [s.name, String(s.fte), String(el), String(tm), mo.toFixed(1), String(best), String(worst), `${best}–${worst} d`]
  })
  const totalRowIndex = bodyRows.length
  bodyRows.push(['TOTAL', '', String(totals.el), String(totals.tm), totals.mo.toFixed(1), String(totals.best), String(totals.worst), `${totals.best}–${totals.worst} d`])

  autoTable(doc, {
    startY: 52,
    margin: { left: ML, right: MR },
    head: [['Release', 'FTE', 'Elapsed d', 'M/D', 'Months', 'Best', 'Worst', 'Range']],
    body: bodyRows,
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
      lineColor: rgb(RULE),
      lineWidth: 0.2,
      textColor: rgb(INK),
    },
    headStyles: {
      fillColor: rgb(NAVY),
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    alternateRowStyles: { fillColor: rgb(ALT) },
    columnStyles: {
      0: { cellWidth: 42 },
      1: { halign: 'right', cellWidth: 12 },
      2: { halign: 'right', cellWidth: 22 },
      3: { halign: 'right', cellWidth: 22 },
      4: { halign: 'right', cellWidth: 18 },
      5: { halign: 'right', cellWidth: 18 },
      6: { halign: 'right', cellWidth: 18 },
      7: { halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === totalRowIndex && data.section === 'body') {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.fillColor = rgb(THD)
      }
      if (data.column.index === 7 && data.section === 'body' && data.row.index !== totalRowIndex) {
        data.cell.styles.textColor = rgb(ORG)
      }
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let curY: number = (doc as any).lastAutoTable?.finalY ?? 90

  // ── Release timeline ──────────────────────────────────────────────────────
  const activeReleases = summary.filter(s => s.res)
  if (activeReleases.length > 0) {
    const wdm = params.workingDaysMonth || 20
    const ganttPng = renderGanttPng(summary, wdm)
    if (ganttPng) {
      const GANTT_ORIG_W = 668
      const GANTT_ORIG_H = 52 + activeReleases.length * 48 + 28
      const ganttMmW = CW
      const ganttMmH = ganttMmW * GANTT_ORIG_H / GANTT_ORIG_W

      curY += 8
      secHeading(curY, 'RELEASE TIMELINE')
      curY += 5

      doc.addImage(`data:image/png;base64,${ganttPng}`, 'PNG', ML, curY, ganttMmW, ganttMmH)
      curY += ganttMmH + 5
    }
  }

  // ── Activity summary ──────────────────────────────────────────────────────
  const activeActs = acts.filter(a => +a.ml > 0 || +a.o > 0 || +a.p > 0)
  if (activeActs.length > 0) {
    const EST_ROW_H = 5
    const SECTION_OVERHEAD = 18   // heading + table header
    const estimatedH = SECTION_OVERHEAD + activeActs.length * EST_ROW_H
    const BOTTOM_RESERVE = 44     // params strip + footer

    if (curY + estimatedH > PAGE_H - BOTTOM_RESERVE) {
      doc.addPage()
      curY = 14
    } else {
      curY += 6
    }

    secHeading(curY, 'ACTIVITY SUMMARY')
    curY += 5

    const actRows = activeActs.map(a => {
      const pert = pertLocal(a.o, a.ml, a.p)
      const exp = +(pert + (Number(a.risk) || 0)).toFixed(1)
      return [a.epic || '—', a.act || '—', a.release || '—', exp]
    })

    autoTable(doc, {
      startY: curY,
      margin: { left: ML, right: MR },
      head: [['Epic', 'Activity', 'Release', 'Expected d']],
      body: actRows,
      styles: {
        font: 'helvetica',
        fontSize: 7.5,
        cellPadding: { top: 2, bottom: 2, left: 3, right: 3 },
        lineColor: rgb(RULE),
        lineWidth: 0.15,
        textColor: rgb(INK),
      },
      headStyles: {
        fillColor: rgb(NAVY),
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 7,
      },
      alternateRowStyles: { fillColor: rgb(ALT) },
      columnStyles: {
        0: { cellWidth: 42 },
        1: { cellWidth: 80 },
        2: { cellWidth: 36 },
        3: { halign: 'right' },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    curY = (doc as any).lastAutoTable?.finalY ?? curY + estimatedH
  }

  // ── Parameters strip ─────────────────────────────────────────────────────
  const PARAM_H = 14
  const FOOTER_H = 12
  const paramY = PAGE_H - FOOTER_H - PARAM_H

  // If content has flowed past the params area, add a new page first
  if (curY + 6 > paramY) {
    doc.addPage()
  }

  doc.setFillColor('#f0f0f8')
  doc.rect(ML, paramY, CW, PARAM_H, 'F')
  doc.setDrawColor('#c8c8e8')
  doc.setLineWidth(0.3)
  doc.rect(ML, paramY, CW, PARAM_H, 'S')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(BORDER_ACC)
  doc.text('ESTIMATION PARAMETERS', ML + 4, paramY + 4.5)

  const pItems = [
    `Sprint: ${params.sprintDays ?? 10} d`,
    `Parallelism: ${Math.round((params.parallelism ?? 0.7) * 100)}%`,
    `AI gain: ${Math.round((params.aiGain ?? 0.3) * 100)}%`,
    `Working days/mo: ${params.workingDaysMonth ?? 20}`,
    `AI cost coef: ${params.aiCostCoef ?? 10}`,
  ]
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(HDR)
  doc.text(pItems.join('   ·   '), ML + 4, paramY + 10.5)

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerLineY = PAGE_H - FOOTER_H + 2
  doc.setDrawColor(RULE)
  doc.setLineWidth(0.2)
  doc.line(ML, footerLineY, PAGE_W - MR, footerLineY)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(MUTED)
  doc.text('Generated by EstimAI  ·  aiscream', PAGE_W / 2, footerLineY + 4, { align: 'center' })

  doc.save(`${(name || 'estimate').replace(/\s+/g, '_')}_estimate.pdf`)
}

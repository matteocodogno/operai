import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import QRCode from 'qrcode'
import type { ReleaseSummary, Totals, Parameters } from '../types'
import { renderGanttPng } from './ganttChart'

// ── A4 layout constants (mm) ──────────────────────────────────────────────────
const PAGE_W = 210
const PAGE_H = 297
const ML = 14
const CW = PAGE_W - ML * 2  // 182 mm

// ── Brand palette ─────────────────────────────────────────────────────────────
const NAVY  = '#1e1e3a'
const ACC   = '#8b96ff'
const GRN   = '#2ec27e'
const ORG   = '#f5a623'
const MUTED = '#7878a8'
const RULE  = '#dcdcec'
const ALT   = '#f5f5fc'
const THD   = '#eaeaf6'

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

export interface ExportPdfOptions {
  name: string
  author: string
  summary: ReleaseSummary[]
  totals: Totals
  params: Parameters
  shareUrl?: string
}

export async function exportPdf({
  name, author, summary, totals, params, shareUrl,
}: ExportPdfOptions): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })

  // ── QR code (async — generate first) ────────────────────────────────────
  let qrDataUrl: string | null = null
  if (shareUrl) {
    qrDataUrl = await QRCode.toDataURL(shareUrl, {
      width: 300,
      margin: 1,
      color: { dark: NAVY, light: '#ffffff' },
    })
  }

  // ── Header strip ─────────────────────────────────────────────────────────
  doc.setFillColor(NAVY)
  doc.rect(0, 0, PAGE_W, 22, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.setTextColor(ACC)
  doc.text('EstimAI', ML, 14)

  doc.setFontSize(11)
  doc.setTextColor('#ffffff')
  doc.text(name || 'Untitled', PAGE_W / 2, 14, { align: 'center', maxWidth: 100 })

  const dateStr = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
  const meta = [author, dateStr].filter(Boolean).join('  ·  ')
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(MUTED)
  doc.text(meta, PAGE_W - ML, 14, { align: 'right' })

  // ── KPI strip ─────────────────────────────────────────────────────────────
  const kpis: { label: string; value: string; color: string }[] = [
    { label: 'Total Elapsed',  value: `${totals.el} d`,              color: ACC },
    { label: 'Man-days',       value: `${totals.tm}`,                color: ACC },
    { label: 'Duration',       value: `${totals.mo.toFixed(1)} mo`,  color: GRN },
    { label: 'Range',          value: `${totals.best}–${totals.worst} d`, color: ORG },
  ]

  const kpiW = CW / kpis.length
  kpis.forEach(({ label, value, color }, i) => {
    const cx = ML + i * kpiW + kpiW / 2
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(color)
    doc.text(value, cx, 32, { align: 'center' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(MUTED)
    doc.text(label.toUpperCase(), cx, 37.5, { align: 'center' })
  })

  doc.setDrawColor(RULE)
  doc.setLineWidth(0.25)
  doc.line(ML, 41, PAGE_W - ML, 41)

  // ── Section heading ───────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(MUTED)
  doc.text('RELEASE SUMMARY', ML, 46.5)

  // ── Summary table ─────────────────────────────────────────────────────────
  const bodyRows: string[][] = summary.map(s => {
    if (!s.res) return [s.name, String(s.fte), '—', '—', '—', '—', '—', '—']
    const { el, tm, mo, best, worst } = s.res
    return [
      s.name, String(s.fte),
      String(el), String(tm), mo.toFixed(1),
      String(best), String(worst), `${best}–${worst} d`,
    ]
  })

  const totalRowIndex = bodyRows.length
  bodyRows.push([
    'TOTAL', '',
    String(totals.el), String(totals.tm), totals.mo.toFixed(1),
    String(totals.best), String(totals.worst),
    `${totals.best}–${totals.worst} d`,
  ])

  autoTable(doc, {
    startY: 49,
    margin: { left: ML, right: ML },
    head: [['Release', 'FTE', 'Elapsed d', 'M/D', 'Months', 'Best', 'Worst', 'Range']],
    body: bodyRows,
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
      lineColor: rgb(RULE),
      lineWidth: 0.2,
      textColor: rgb('#1a1a2e'),
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
  const tableEndY: number = (doc as any).lastAutoTable?.finalY ?? 80

  // ── Gantt chart ───────────────────────────────────────────────────────────
  const activeReleases = summary.filter(s => s.res)
  if (activeReleases.length > 0) {
    const wdm = params.workingDaysMonth || 20
    const ganttPng = renderGanttPng(summary, wdm)
    if (ganttPng) {
      const GANTT_ORIG_W = 668
      const GANTT_ORIG_H = 52 + activeReleases.length * 48 + 28
      const ganttMmW = CW
      const ganttMmH = ganttMmW * GANTT_ORIG_H / GANTT_ORIG_W
      const ganttY = tableEndY + 8

      if (ganttY + ganttMmH < PAGE_H - (qrDataUrl ? 68 : 20)) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(6.5)
        doc.setTextColor(MUTED)
        doc.text('RELEASE TIMELINE', ML, ganttY - 2)
        doc.addImage(`data:image/png;base64,${ganttPng}`, 'PNG', ML, ganttY, ganttMmW, ganttMmH)
      }
    }
  }

  // ── QR code box (bottom-right, page 1) ───────────────────────────────────
  if (qrDataUrl) {
    const QR = 36
    const PAD = 4
    const CAPTION_H = 7
    const BOX_W = QR + PAD * 2
    const BOX_H = QR + PAD + CAPTION_H + PAD
    const bx = PAGE_W - ML - BOX_W
    const by = PAGE_H - 14 - BOX_H

    doc.setDrawColor(RULE)
    doc.setLineWidth(0.4)
    doc.roundedRect(bx, by, BOX_W, BOX_H, 2, 2, 'S')

    doc.addImage(qrDataUrl, 'PNG', bx + PAD, by + PAD, QR, QR)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(MUTED)
    doc.text('Scan to view online', bx + BOX_W / 2, by + PAD + QR + 5, { align: 'center' })
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.setDrawColor(RULE)
  doc.setLineWidth(0.2)
  doc.line(ML, PAGE_H - 8, PAGE_W - ML, PAGE_H - 8)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(MUTED)
  doc.text('Generated by EstimAI  ·  wellD.ch', PAGE_W / 2, PAGE_H - 4, { align: 'center' })

  doc.save(`${(name || 'estimate').replace(/\s+/g, '_')}_estimate.pdf`)
}

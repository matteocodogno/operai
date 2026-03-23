import type { ReleaseSummary } from '../types'

const BG       = '#12121e'
const TITLE_FG = '#e8e8f8'
const LABEL_FG = '#9090b8'
const BAR_MAIN = '#8b96ff'
const BAR_BEST = '#2ec27e'
const BAR_WRST = 'rgba(139,150,255,0.18)'
const GRID_COL = 'rgba(255,255,255,0.07)'

/**
 * Draws a horizontal Gantt-style bar chart and returns the PNG as a base64 string
 * (no data: prefix — ready for ExcelJS addImage).
 */
export function renderGanttPng(rows: ReleaseSummary[], wdm: number): string {
  const active = rows.filter(s => s.res)
  if (!active.length) return ''

  const maxEl = Math.max(...active.map(s => s.res!.worst), 1)

  const SCALE    = 2          // retina
  const LABEL_W  = 120
  const BAR_W    = 500
  const ROW_H    = 48
  const PAD      = { top: 52, right: 32, bottom: 28, left: 16 }
  const W        = PAD.left + LABEL_W + BAR_W + PAD.right
  const H        = PAD.top + active.length * ROW_H + PAD.bottom

  const canvas   = document.createElement('canvas')
  canvas.width   = W  * SCALE
  canvas.height  = H  * SCALE
  const ctx      = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  // Title
  ctx.fillStyle = TITLE_FG
  ctx.font = 'bold 13px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('Release Timeline', PAD.left, 30)

  // Vertical grid lines (every 25% of maxEl)
  for (let t = 1; t <= 4; t++) {
    const gx = PAD.left + LABEL_W + (t / 4) * BAR_W
    ctx.strokeStyle = GRID_COL
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(gx, PAD.top - 8)
    ctx.lineTo(gx, H - PAD.bottom)
    ctx.stroke()
    // Month label
    const mo = ((maxEl * t / 4) / wdm).toFixed(1)
    ctx.fillStyle = LABEL_FG
    ctx.font = '9px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${mo} mo`, gx, PAD.top - 12)
  }

  active.forEach((s, i) => {
    const res = s.res!
    const y   = PAD.top + i * ROW_H

    // Release label
    ctx.fillStyle = LABEL_FG
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(s.name, PAD.left + LABEL_W - 10, y + ROW_H * 0.58)

    const bar = (v: number) => Math.max((v / maxEl) * BAR_W, 2)
    const bh = ROW_H - 20
    const by = y + 10

    // Worst-case background
    ctx.fillStyle = BAR_WRST
    ctx.beginPath()
    ctx.roundRect(PAD.left + LABEL_W, by, bar(res.worst), bh, 3)
    ctx.fill()

    // Best-case accent
    ctx.fillStyle = BAR_BEST
    ctx.globalAlpha = 0.35
    ctx.beginPath()
    ctx.roundRect(PAD.left + LABEL_W, by, bar(res.best), bh, 3)
    ctx.fill()
    ctx.globalAlpha = 1

    // Main elapsed bar
    ctx.fillStyle = BAR_MAIN
    ctx.beginPath()
    ctx.roundRect(PAD.left + LABEL_W, by, bar(res.el), bh, 3)
    ctx.fill()

    // Elapsed label inside / after bar
    const mo = res.mo.toFixed(1)
    const barPx = bar(res.el)
    const labelInside = barPx > 50
    ctx.fillStyle = labelInside ? '#fff' : TITLE_FG
    ctx.font = 'bold 10px system-ui, sans-serif'
    ctx.textAlign = labelInside ? 'right' : 'left'
    const lx = PAD.left + LABEL_W + (labelInside ? barPx - 6 : barPx + 6)
    ctx.fillText(`${mo} mo`, lx, by + bh * 0.68)
  })

  return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
}

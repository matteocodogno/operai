import type { ReleaseSummary } from '../types'

// ── Light chart palette ────────────────────────────────────────────────────────
const BG = '#f8f8fc' // very light cool grey
const GRID_COL = '#e4e4ee' // subtle grid lines
const TITLE_FG = '#0d0d14' // chart title
const LABEL_FG = '#0d0d14' // release label text
const AXIS_FG = '#6b6b88' // month axis labels
const BAR_MAIN = '#5b6af7' // expected elapsed bar
const BAR_RANGE = '#f5a623' // best–worst range extension (same orange as Range column)

/**
 * Draws a horizontal Gantt-style bar chart and returns the PNG as a base64 string
 * (no data: prefix — ready for ExcelJS addImage).
 */
export function renderGanttPng(rows: ReleaseSummary[], wdm: number): string {
  const active = rows.filter((s) => s.res)
  if (!active.length) return ''

  const maxEl = Math.max(...active.map((s) => s.res!.worst), 1)

  const SCALE = 2 // retina
  const LABEL_W = 120
  const BAR_W = 500
  const ROW_H = 48
  const PAD = { top: 52, right: 32, bottom: 28, left: 16 }
  const W = PAD.left + LABEL_W + BAR_W + PAD.right
  const H = PAD.top + active.length * ROW_H + PAD.bottom

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  // Title
  ctx.fillStyle = TITLE_FG
  ctx.font = '600 13px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('Release Timeline', PAD.left, 30)

  // Vertical grid lines + month labels
  for (let t = 1; t <= 4; t++) {
    const gx = PAD.left + LABEL_W + (t / 4) * BAR_W
    ctx.strokeStyle = GRID_COL
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(gx, PAD.top - 8)
    ctx.lineTo(gx, H - PAD.bottom)
    ctx.stroke()

    const mo = ((maxEl * t) / 4 / wdm).toFixed(1)
    ctx.fillStyle = AXIS_FG
    ctx.font = '9px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${mo} mo`, gx, PAD.top - 12)
  }

  active.forEach((s, i) => {
    const res = s.res!
    const y = PAD.top + i * ROW_H

    // Release label
    ctx.fillStyle = LABEL_FG
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(s.name, PAD.left + LABEL_W - 10, y + ROW_H * 0.58)

    const bar = (v: number) => Math.max((v / maxEl) * BAR_W, 2)
    const bh = ROW_H - 20
    const by = y + 10
    const barX = PAD.left + LABEL_W

    // Range bar (0 → worst) drawn behind expected — orange at 35% opacity
    ctx.globalAlpha = 0.35
    ctx.fillStyle = BAR_RANGE
    ctx.beginPath()
    ctx.roundRect(barX, by, bar(res.worst), bh, 3)
    ctx.fill()
    ctx.globalAlpha = 1

    // Expected elapsed bar — solid purple
    ctx.fillStyle = BAR_MAIN
    ctx.beginPath()
    ctx.roundRect(barX, by, bar(res.el), bh, 3)
    ctx.fill()

    // Elapsed label (inside bar if wide enough, outside otherwise)
    const mo = res.mo.toFixed(1)
    const elBarPx = bar(res.el)
    const labelInside = elBarPx > 50
    ctx.fillStyle = labelInside ? '#ffffff' : BAR_MAIN
    ctx.font = '500 10px system-ui, sans-serif'
    ctx.textAlign = labelInside ? 'right' : 'left'
    const lx = barX + (labelInside ? elBarPx - 6 : elBarPx + 6)
    ctx.fillText(`${mo} mo`, lx, by + bh * 0.68)

    // Range label (best–worst d) after the worst bar, in orange
    const worstBarPx = bar(res.worst)
    if (worstBarPx < BAR_W - 30) {
      ctx.fillStyle = BAR_RANGE
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`${res.best}–${res.worst}d`, barX + worstBarPx + 6, by + bh * 0.68)
    }
  })

  return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
}

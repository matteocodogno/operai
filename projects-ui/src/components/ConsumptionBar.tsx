import { cx, formatNumber } from '@operai/ui'
import { BAR_MARKS, CLOSE_TO_LIMIT_PERCENT, OVER_PERCENT, SCALE_END_PERCENT } from '../lib/consumption'
import type { Share } from '../lib/consumption'
import { strings } from '../strings'

/** The end of the track, in percent of its length: where the scale's last tick and label sit (125 % of the reference). */
const TRACK_END = 100

/**
 * A state's fill and, beyond the 100 % mark, its stripes — complete class strings, never built from a name (plan R12). Only
 * an over share has a beyond part, so the other two states have no stripes. With no state said the bar is neutral: a
 * tone without its words would be colour alone (AC-5.10, design G10).
 */
const TONES = {
  on_track: { fill: 'bg-acc-solid', stripes: null },
  close_to_limit: { fill: 'bg-org', stripes: null },
  over: { fill: 'bg-red', stripes: 'bg-linear-90 from-red from-50% to-transparent to-50% bg-size-[6px_100%]' },
} as const
const NEUTRAL = { fill: 'bg-soft', stripes: 'bg-linear-90 from-soft from-50% to-transparent to-50% bg-size-[6px_100%]' }

/** The marks' labels stay inside a narrow bar: below these a label starts at its mark, above them it ends there (layout only). */
const TODAY_START_BELOW = 8
const ESTIMATE_START_BELOW = 14
const ESTIMATE_END_ABOVE = 86

const percentLabel = (percent: number): string =>
  formatNumber(percent / 100, { style: 'percent', maximumFractionDigits: 0 })

/**
 * ConsumptionBar — the drawing of a share (specs/20261112-project-hours US-5, design S1.1, plan D-P8): a track on a scale
 * of 0–125 % of the reference, the fill up to the consumed part of it, the part beyond the 100 % mark as an element of its
 * own with vertical stripes (told apart by shape, AC-5.15), ticks at 80 % and 100 %, a today mark and the estimate's.
 *
 * It computes nothing: every position is `share.bar`, in percent of the bar's length, and its tone is the share's state.
 * It is `aria-hidden` and holds only a closed set of labels — the scale's "80%", "100%" and "125%", "Today" at the today
 * mark and "Estimate" at the estimate mark — decoration of the drawing, never a figure the lines do not state (AC-5.11): the
 * pace line says the percentage and the time elapsed, the state line the state, the facts the excess and the estimate. No
 * role, no tab stop, no tooltip, no animation. Inline `style` is widths and positions only; colours are token utilities.
 *
 * One deviation from design S1.1, found rendering it: the "125%" label (the drawing's own end) is dropped from a bar narrower than
 * 230 px, by a container query on the bar's own width (`@container`, `@max-[230px]:hidden`). The shell keeps its 64 px rail at
 * every width, so the card's inner width is 205 px at 360 and about 165 px at 320, not the 274 and 234 the design counted, and
 * below about 215 px "100%" and "125%" touch. "80%" and "100%", which the state words stand for, stay.
 */
export default function ConsumptionBar({ share }: { share: Share }) {
  const { bar, state } = share
  const tone = state === null ? NEUTRAL : TONES[state]
  const t = strings.project.consumption.bar
  return (
    <div aria-hidden="true" data-testid="project-hours-consumption-bar" className="relative @container">
      {bar.today !== null && (
        <div className="relative h-5">
          <span
            className={cx(
              'absolute bottom-1 font-mono text-2xs text-text',
              bar.today >= TODAY_START_BELOW && '-translate-x-1/2',
            )}
            style={{ left: `${bar.today}%` }}
          >
            {t.today}
          </span>
        </div>
      )}
      <div data-testid="project-hours-consumption-bar-track" className="relative h-2.5">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-ink ring-1 ring-dim">
          {bar.within > 0 && (
            <div
              data-testid="project-hours-consumption-bar-fill"
              className={cx('absolute inset-y-0 left-0', tone.fill)}
              style={{ width: `${bar.within}%` }}
            />
          )}
          {bar.beyond > 0 && (
            <div
              data-testid="project-hours-consumption-bar-beyond"
              className={cx('absolute inset-y-0', tone.stripes)}
              style={{ left: `${BAR_MARKS.over}%`, width: `${bar.beyond}%` }}
            />
          )}
        </div>
        {[BAR_MARKS.closeToLimit, BAR_MARKS.over, TRACK_END].map((left) => (
          <div
            key={left}
            data-testid="project-hours-consumption-bar-tick"
            className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-soft ring-1 ring-ink"
            style={{ left: `${left}%` }}
          />
        ))}
        {bar.today !== null && (
          <div
            data-testid="project-hours-consumption-bar-today"
            className="absolute -top-1.5 h-4 w-0.5 -translate-x-1/2 bg-text ring-1 ring-ink"
            style={{ left: `${bar.today}%` }}
          />
        )}
        {bar.estimate !== null && (
          <div
            data-testid="project-hours-consumption-bar-estimate"
            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-text ring-1 ring-ink"
            style={{ left: `${bar.estimate}%` }}
          />
        )}
      </div>
      <div className="relative mt-2 h-4">
        <span
          className="absolute -translate-x-1/2 font-mono text-2xs text-soft"
          style={{ left: `${BAR_MARKS.closeToLimit}%` }}
        >
          {percentLabel(CLOSE_TO_LIMIT_PERCENT)}
        </span>
        <span className="absolute -translate-x-1/2 font-mono text-2xs text-soft" style={{ left: `${BAR_MARKS.over}%` }}>
          {percentLabel(OVER_PERCENT)}
        </span>
        <span
          className="absolute -translate-x-full font-mono text-2xs text-soft @max-[230px]:hidden"
          style={{ left: `${TRACK_END}%` }}
        >
          {percentLabel(SCALE_END_PERCENT)}
        </span>
      </div>
      {bar.estimate !== null && (
        <div className="relative h-4">
          <span
            className={cx(
              'absolute flex items-center gap-1.5 font-mono text-2xs text-text',
              bar.estimate >= ESTIMATE_START_BELOW && bar.estimate <= ESTIMATE_END_ABOVE && '-translate-x-1/2',
              bar.estimate > ESTIMATE_END_ABOVE && '-translate-x-full',
            )}
            style={{ left: `${bar.estimate}%` }}
          >
            <span className="inline-block size-2 rotate-45 bg-text ring-1 ring-ink" />
            <span>{t.estimate}</span>
          </span>
        </div>
      )}
    </div>
  )
}

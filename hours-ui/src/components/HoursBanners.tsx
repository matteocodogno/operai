import { Banner } from '@operai/ui'
import type { UnavailableSource } from '../lib/hoursApi.types'
import { strings } from '../strings'

export type HoursBannersProps = {
  /** The sources a read could not ask (`unavailableSources` of every answer on screen), in the catalog's order. */
  sources: UnavailableSource[]
  /** Grouping by deal while the meeting → deal link did not answer: the meeting hours are one separate row. */
  dealGroupingUnavailable: boolean
  /** Anything on screen is withheld because the viewer may not read it (`hasHiddenName`). */
  hiddenNames: boolean
  /**
   * The words of that note when a page has its own (Everyone's hours, T29, design S4); My hours uses the
   * entries catalog's. The note stays a named, static one whatever the words.
   */
  hiddenCopy?: { label: string; body: string }
}

/**
 * HoursBanners — the notes a view of hours carries about names it could not load or may not show
 * (specs/029-time-tracking T25; design S1 states "Source down" and "Names not visible"; AC-4.7, AC-4.10).
 * Shared by My hours and Everyone's hours, each note only when it applies:
 *
 * - names missing (`info`, polite): hours are complete, these sources did not answer, so their names show as
 *   unavailable — one banner however many sources;
 * - deal grouping (`warning` in tone, polite): the meeting hours cannot be placed under their deal right now;
 *   never an `alert`, because the totals read fine and only a grouping is degraded;
 * - names not visible (`info`, `live="off"`): a standing fact the viewer reads in place, named for a screen
 *   reader that lands on it, and never announced.
 */
export default function HoursBanners({
  sources,
  dealGroupingUnavailable,
  hiddenNames,
  hiddenCopy = strings.entries.banners.hidden,
}: HoursBannersProps) {
  const t = strings.entries.banners
  if (sources.length === 0 && !dealGroupingUnavailable && !hiddenNames) return null
  return (
    <div className="flex flex-col gap-3" data-testid="hours-banners">
      {sources.length > 0 && (
        <Banner tone="info" live="polite" data-testid="hours-banner-unavailable">
          {t.unavailable(sources.map((source) => strings.names.sources[source]).join(', '))}
        </Banner>
      )}
      {dealGroupingUnavailable && (
        <Banner tone="warning" live="polite" data-testid="hours-banner-deal-grouping">
          {t.dealGrouping}
        </Banner>
      )}
      {hiddenNames && (
        <Banner tone="info" live="off" aria-label={hiddenCopy.label} data-testid="hours-banner-hidden">
          {hiddenCopy.body}
        </Banner>
      )}
    </div>
  )
}

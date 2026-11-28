import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import {
  Banner,
  FactList,
  Icon,
  StatusBadge,
  VisuallyHidden,
  cx,
  formatDate,
  formatDuration,
  formatNumber,
} from '@operai/ui'
import type { Fact, IconName } from '@operai/ui'
import { useResource } from '../hooks/useResource'
import { consumptionOf, dateSignalsOf, hasConsumptionBlock, summaryRequestOf } from '../lib/consumption'
import type { Consumption, ConsumptionState, DateSignal, Level, Share } from '../lib/consumption'
import { getHoursSummary } from '../lib/hoursApi'
import { TIME_ENTRY_RECORDED, isTimeEntryRecordedDetail } from '../lib/timeEntryRecordedEvent'
import type { ProjectState, Terms } from '../lib/types'
import { strings } from '../strings'
import ConsumptionBar from './ConsumptionBar'
import { Loading } from './LoadState'

type Drawn = Exclude<Consumption, { variant: 'none' } | { variant: 'unavailable' }>

/** A comparison: the variants that carry a share (a package that has not started has none, AC-5.4). */
type Compared = Extract<Drawn, { share: Share | null }>

/** A duration of whole minutes: the short text for the eye, the spoken one for the reader (as hours-ui's `Duration`). */
function Duration({ minutes }: { minutes: number }) {
  return (
    <span className="font-mono">
      <span aria-hidden="true">{formatDuration(minutes * 60_000, { style: 'short' })}</span>
      <VisuallyHidden>{formatDuration(minutes * 60_000, { style: 'spoken' })}</VisuallyHidden>
    </span>
  )
}

const oneDecimal = (value: number): string =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Man-days from whole tenths, always with one decimal (AC-1.6): "7.5 man-days", "10.0 man-days". */
const manDays = (tenths: number): ReactNode => (
  <span className="font-mono">{strings.terms.details.manDays(oneDecimal(tenths / 10))}</span>
)

/**
 * The excess of a fixed price or of time and material, as a last fact "Over by" — only when over (AC-5.12). In man-days with
 * one decimal; an excess that would round to 0.0 reads "Less than 0.1 man-day", never zero (AC-5.13). A package's excess is
 * its own "Hours left" turning into "Over by" (D81), so it is not added a second time.
 */
function manDayExcess(share: Share | null): Fact[] {
  const excess = share?.excess
  if (!excess || excess.unit !== 'man_days') return []
  const t = strings.project.consumption
  return [
    {
      id: 'over',
      term: t.overBy,
      value: excess.belowOneTenth ? (
        <span className="font-mono">{t.excess.lessThanOneTenth(oneDecimal(0.1))}</span>
      ) : (
        manDays(excess.tenths)
      ),
    },
  ]
}

/**
 * The facts of one variant and the one-line rule under them. The terms' own words are reused (the package kind,
 * "Estimated man-days", "Max effort", "Planned man-days"); this block adds what it compares and the notes a reader
 * could not otherwise know (AC-1.2, A51, AC-1.6).
 */
function factsOf(drawn: Drawn): { items: Fact[]; note: string | null } {
  const t = strings.project.consumption
  const d = strings.terms.details
  switch (drawn.variant) {
    case 'package_not_started':
      return {
        items: [
          { id: 'package', term: d.kinds[drawn.kind], value: <Duration minutes={drawn.packageMinutes} /> },
          { id: 'starts', term: t.startsOn, value: <span className="font-mono">{formatDate(drawn.startDate)}</span> },
        ],
        note: t.notStartedNote,
      }
    case 'package': {
      const yearly = drawn.kind === 'yearly'
      const from = formatDate(drawn.period.from)
      // An open-ended capacity package has no end to show; "Over by" takes the place of "Hours left" once it is exceeded (D81).
      const dates = drawn.period.to === null ? t.since(from) : t.range(from, formatDate(drawn.period.to))
      const exceeded = drawn.overByMinutes > 0
      return {
        items: [
          { id: 'package', term: d.kinds[drawn.kind], value: <Duration minutes={drawn.packageMinutes} /> },
          {
            id: 'period',
            term: yearly ? t.currentPeriod : t.packagePeriod,
            value: (
              <>
                <span className="font-mono">{dates}</span>
                {drawn.ended && (
                  <>
                    {' '}
                    <StatusBadge status="voided" data-testid="project-hours-consumption-expired">
                      {t.expired}
                    </StatusBadge>
                  </>
                )}
              </>
            ),
          },
          {
            id: 'used',
            term: yearly ? t.hoursUsedInPeriod : t.hoursUsed,
            value: <Duration minutes={drawn.usedMinutes} />,
          },
          {
            id: 'rest',
            term: exceeded ? t.overBy : t.hoursLeft,
            value: <Duration minutes={exceeded ? drawn.overByMinutes : drawn.leftMinutes} />,
          },
        ],
        note: yearly ? t.yearlyNote : null,
      }
    }
    case 'fixed_price':
      return {
        items: [
          { id: 'used', term: t.manDaysUsed, value: manDays(drawn.usedTenths) },
          // Left out, not "None", when the terms carry no estimate (AC-1.4).
          ...(drawn.estimatedTenths === null
            ? []
            : [{ id: 'estimated', term: d.estimatedManDays, value: manDays(drawn.estimatedTenths) }]),
          { id: 'max', term: d.maxEffortManDays, value: manDays(drawn.maxEffortTenths) },
          ...manDayExcess(drawn.share),
        ],
        note: t.fixedPriceNote,
      }
    case 't_and_m':
      return {
        items: [
          { id: 'used', term: t.manDaysUsed, value: manDays(drawn.usedTenths) },
          { id: 'planned', term: d.plannedManDays, value: manDays(drawn.plannedTenths) },
          ...manDayExcess(drawn.share),
        ],
        note: t.timeAndMaterialNote,
      }
  }
}

/** The block's frame: a named group (there is no heading of its own: the card's title is the heading), and the target of a focus move. */
function Group({ children, groupRef }: { children: ReactNode; groupRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={strings.project.consumption.label}
      tabIndex={-1}
      data-testid="project-hours-consumption"
    >
      {children}
    </div>
  )
}

/**
 * The state line's icon and the colour of its words, one complete class string each (plan R12): an icon per LEVEL —
 * none for on track, the warning glyph for close to the limit, the danger glyph for over — so no state is told by
 * colour alone (AC-5.10, D96). Words are only ever in `*-text` tokens (`--org` and `--red` are not text colours in the
 * light theme).
 */
const STATE_LINE = {
  on_track: { icon: 'check', words: 'text-acc-text' },
  close_to_limit: { icon: 'alert', words: 'text-org-text' },
  over: { icon: 'x-circle', words: 'text-red-text' },
} as const satisfies Record<ConsumptionState, { icon: IconName; words: string }>

/** The words of a state. `over` has two wordings of one state (D95): "Limit reached" when the hours equal the reference exactly (no excess), "Over the limit" above it. */
function stateWords(state: ConsumptionState, share: Share): string {
  const t = strings.project.consumption.state
  switch (state) {
    case 'on_track':
      return t.onTrack
    case 'close_to_limit':
      return t.closeToLimit
    case 'over':
      return share.excess === null ? t.limitReached : t.over
  }
}

/** A whole percent as a sentence takes it: the integer and its text from the formatter, so no sentence formats (AC-3.2, R11). */
const percentOf = (value: number) => ({
  n: value,
  text: formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 0 }),
})

/**
 * The state in words with the icon of its level at the left, the consumed percentage at the right (the pace line says the
 * same figure in text, so this one is `aria-hidden`). With no state said — an ended capacity package, a closed or cancelled
 * project (AC-5.25, AC-5.26) — the left side is absent and the percentage keeps its place at the right.
 */
function StateLine({ share }: { share: Share }) {
  const state = share.state
  return (
    <div className="flex items-center justify-between gap-3">
      {state !== null && (
        <p
          data-testid="project-hours-consumption-state"
          className={cx('flex items-center gap-2 text-sm font-medium', STATE_LINE[state].words)}
        >
          <Icon name={STATE_LINE[state].icon} />
          {stateWords(state, share)}
        </p>
      )}
      <span
        aria-hidden="true"
        data-testid="project-hours-consumption-percent"
        className="ml-auto font-mono text-base text-text"
      >
        {percentOf(share.consumedPercent).text}
      </span>
    </div>
  )
}

/**
 * The one line that states the consumed percentage and, where the terms have a span with an end, the time elapsed
 * (AC-5.18, AC-5.19): what the bar draws, in words, so the block reads complete without it (AC-5.11). It judges nothing and
 * forecasts nothing.
 */
function PaceLine({ drawn, share }: { drawn: Compared; share: Share }) {
  const t = strings.project.consumption.pace
  const used = percentOf(share.consumedPercent)
  const elapsed = share.elapsedPercent === null ? null : percentOf(share.elapsedPercent)
  const words =
    drawn.variant === 'package'
      ? elapsed === null
        ? t.hours(used)
        : t.hoursElapsed(used, elapsed)
      : drawn.variant === 'fixed_price'
        ? elapsed === null
          ? t.maxEffort(used)
          : t.maxEffortElapsed(used, elapsed)
        : t.plannedManDays(used)
  return (
    <p data-testid="project-hours-consumption-pace" className="text-xs text-soft">
      {words}
    </p>
  )
}

/**
 * A date line's icon and box, one complete class string each (plan R12): the graver level for a date that has passed, the
 * milder for one that is near — the same two shapes a state of the same level has, so a signal is never told by colour alone
 * (AC-5.10, D96). The words are in the `*-text` token of the level, the box a border and a 10 % tint of its tone.
 */
const DATE_LINE = {
  milder: { icon: 'alert', box: 'border-org/40 bg-org/10 text-org-text' },
  graver: { icon: 'x-circle', box: 'border-red/40 bg-red/10 text-red-text' },
} as const satisfies Record<Level, { icon: IconName; box: string }>

/** Which date, and that it has passed (by how many days) or is near (in how many, `0` said as today, D94). */
function dateWords(signal: DateSignal): string {
  const t = strings.project.consumption.dates[signal.which === 'deadline' ? 'deadline' : 'endDate']
  const days = { n: signal.days, text: formatNumber(signal.days) }
  if (signal.when === 'passed') return t.passed(days)
  return signal.days === 0 ? t.today : t.near(days)
}

/**
 * One date of the terms that has passed or is near: its words with the icon of its level at the left, the date at the
 * right. A box that wraps, so at 320 px the date drops under the words. Not a `Banner` (orange there means "try again", and
 * it is heavier than a line in a block of figures) and not an alert: no role, nothing announced (AC-5.24).
 */
function DateLine({ signal }: { signal: DateSignal }) {
  const line = DATE_LINE[signal.level]
  return (
    <div
      data-testid={
        signal.which === 'deadline'
          ? 'project-hours-consumption-date-deadline'
          : 'project-hours-consumption-date-end-date'
      }
      className={cx(
        'flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm',
        line.box,
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <Icon name={line.icon} />
        {dateWords(signal)}
      </p>
      <p className="flex items-center gap-1.5 font-mono text-xs text-text">
        <Icon name="calendar" />
        <time dateTime={signal.date}>{formatDate(signal.date)}</time>
      </p>
    </div>
  )
}

/**
 * What the block says under its facts: the share of a comparison — state line, bar, pace line, drawn together or not at
 * all — then the date lines, each when its rule says so. The date lines read the terms alone, so they stand beside a
 * share, beside the "unavailable" warning, below the skeleton and alone (AC-5.24). `standalone`: nothing precedes the
 * region (terms of an SLA with an end date that is near), so there is no gap above it.
 */
function Signals({
  compared,
  dates,
  standalone = false,
}: {
  compared: Compared | null
  dates: DateSignal[]
  standalone?: boolean
}) {
  const share = compared?.share ?? null
  if (share === null && dates.length === 0) return null
  return (
    <div className={cx('flex w-full max-w-xl flex-col', !standalone && 'mt-4')}>
      {compared !== null && share !== null && (
        <div className="flex flex-col gap-2">
          <StateLine share={share} />
          <ConsumptionBar share={share} />
          <PaceLine drawn={compared} share={share} />
        </div>
      )}
      {dates.length > 0 && (
        <div className={cx('flex flex-col gap-2', share !== null && 'mt-3')}>
          {dates.map((signal) => (
            <DateLine key={signal.which} signal={signal} />
          ))}
        </div>
      )}
    </div>
  )
}

function Facts({ drawn }: { drawn: Drawn }) {
  const { items, note } = factsOf(drawn)
  return (
    <>
      <FactList items={items} testId="project-hours-consumption-facts" />
      {note !== null && <p className="mt-2 text-xs text-soft">{note}</p>}
    </>
  )
}

type Span = { from: string; to: string } | null

/**
 * The part that reads: asks hours-api once for the project (with the package's window when there is one) and draws
 * `consumptionOf`'s answer. It is complete or absent — never a figure it could not read (AC-4.9) — and it reads again, keeping what is
 * on screen until the answer, when Record hours announces a save on this project (D84).
 */
function SummaryConsumption({
  projectId,
  terms,
  state,
  span,
}: {
  projectId: string
  terms: Terms | null
  state: ProjectState
  span: Span
}) {
  const from = span?.from ?? null
  const to = span?.to ?? null
  const load = useCallback(
    (signal: AbortSignal) => getHoursSummary(projectId, from !== null && to !== null ? { from, to } : null, { signal }),
    [projectId, from, to],
  )
  // `keepDataOnRetry`: a re-read keeps the figures on screen (no skeleton, no jump) until its answer; a failed one is an error.
  const resource = useResource(load, { keepDataOnRetry: true })
  const { retry } = resource

  // A save with Record hours on THIS project asks the owner again; the event carries no figure and none is taken from it.
  // Several in a burst are one render, so one read; one while a read is in flight restarts it (useResource aborts the old).
  useEffect(() => {
    const onRecorded = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (isTimeEntryRecordedDetail(detail) && detail.on === 'project' && detail.targetId === projectId) retry()
    }
    window.addEventListener(TIME_ENTRY_RECORDED, onRecorded)
    return () => window.removeEventListener(TIME_ENTRY_RECORDED, onRecorded)
  }, [projectId, retry])

  // After a Retry the button is gone: when the answer arrives, whichever it is, focus goes to the block (design S1).
  const groupRef = useRef<HTMLDivElement>(null)
  const focusWhenRead = useRef(false)
  useEffect(() => {
    if (focusWhenRead.current && resource.status !== 'loading' && !resource.refreshing) {
      focusWhenRead.current = false
      groupRef.current?.focus()
    }
  })

  const drawn = resource.status === 'ready' ? consumptionOf(terms, resource.data, state) : null
  // Never "none" here — this part only exists for terms `summaryRequestOf` asked a summary for — but the type says it can be.
  if (drawn?.variant === 'none') return null
  // The dates read the terms alone: they stand while the hours load and when they cannot be read (AC-5.24).
  const dates = dateSignalsOf(terms, state)
  return (
    <Group groupRef={groupRef}>
      {resource.status === 'loading' ? (
        <>
          <Loading label={strings.project.consumption.loading} rows={2} />
          <Signals compared={null} dates={dates} />
        </>
      ) : drawn === null || drawn.variant === 'unavailable' ? (
        <>
          <Banner
            tone="warning"
            title={strings.project.consumption.unavailable.title}
            onRetry={() => {
              focusWhenRead.current = true
              retry()
            }}
            retryLabel={strings.common.retry}
            data-testid="project-hours-consumption-unavailable"
          >
            {strings.project.consumption.unavailable.body}
          </Banner>
          <Signals compared={null} dates={dates} />
        </>
      ) : (
        <>
          <Facts drawn={drawn} />
          <Signals compared={drawn.variant === 'package_not_started' ? null : drawn} dates={dates} />
        </>
      )}
    </Group>
  )
}

/**
 * ConsumptionBlock — what the project's terms sold, set against the hours recorded on it (specs/20261112-project-hours
 * US-1; design S1): a block inside the page's ONE "Hours" card, not a card. Which of the four variants it draws, and
 * whether it has to ask hours-api at all, is `lib/consumption.ts`'s (a package that has not started is drawn from
 * the terms alone, A51; terms that sold nothing comparable draw nothing at all, AC-1.7). It is composed here, by the
 * screen of the terms' owner, from the terms and the summary (plan D-P3), and shows no amount, price or rate (AC-1.8).
 * `state` is the project's own: the signals of US-5 (the state said, the date lines) read it, and a closed or cancelled
 * project says no state and no date (AC-5.26).
 */
export default function ConsumptionBlock({
  projectId,
  terms,
  state,
}: {
  projectId: string
  terms: Terms | null
  state: ProjectState
}) {
  // The one rule the card draws its divider by too: terms that sold something comparable, or a date that has passed or is
  // near — so an SLA-only project with a near end date has a block of its date line alone (AC-1.7 amended).
  if (!hasConsumptionBlock(terms, state)) return null
  const request = summaryRequestOf(terms)
  if (request === null) {
    const sold = consumptionOf(terms, null, state)
    const dates = dateSignalsOf(terms, state)
    // A package that has not started is drawn from the terms alone: its facts, then its dates. Terms that sold nothing
    // comparable have the date lines alone, with nothing above them.
    return (
      <Group>
        {sold.variant === 'package_not_started' && <Facts drawn={sold} />}
        <Signals compared={null} dates={dates} standalone={sold.variant !== 'package_not_started'} />
      </Group>
    )
  }
  return <SummaryConsumption projectId={projectId} terms={terms} state={state} span={request.window} />
}

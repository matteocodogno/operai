import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import { Banner, FactList, StatusBadge, VisuallyHidden, formatDate, formatDuration, formatNumber } from '@operai/ui'
import type { Fact } from '@operai/ui'
import { useResource } from '../hooks/useResource'
import { consumptionOf, summaryRequestOf } from '../lib/consumption'
import type { Consumption } from '../lib/consumption'
import { getHoursSummary } from '../lib/hoursApi'
import { TIME_ENTRY_RECORDED, isTimeEntryRecordedDetail } from '../lib/timeEntryRecordedEvent'
import type { Terms } from '../lib/types'
import { strings } from '../strings'
import { Loading } from './LoadState'

type Drawn = Exclude<Consumption, { variant: 'none' } | { variant: 'unavailable' }>

/** A duration of whole minutes: the short text for the eye, the spoken one for the reader (as hours-ui's `Duration`). */
function Duration({ minutes }: { minutes: number }) {
  return (
    <span className="font-mono">
      <span aria-hidden="true">{formatDuration(minutes * 60_000, { style: 'short' })}</span>
      <VisuallyHidden>{formatDuration(minutes * 60_000, { style: 'spoken' })}</VisuallyHidden>
    </span>
  )
}

/** Man-days from whole tenths, always with one decimal (AC-1.6): "7.5 man-days", "10.0 man-days". */
const manDays = (tenths: number): ReactNode => (
  <span className="font-mono">
    {strings.terms.details.manDays(formatNumber(tenths / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }))}
  </span>
)

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
        ],
        note: t.fixedPriceNote,
      }
    case 't_and_m':
      return {
        items: [
          { id: 'used', term: t.manDaysUsed, value: manDays(drawn.usedTenths) },
          { id: 'planned', term: d.plannedManDays, value: manDays(drawn.plannedTenths) },
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
function SummaryConsumption({ projectId, terms, span }: { projectId: string; terms: Terms | null; span: Span }) {
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

  const drawn = resource.status === 'ready' ? consumptionOf(terms, resource.data) : null
  // Never "none" here — this part only exists for terms `summaryRequestOf` asked a summary for — but the type says it can be.
  if (drawn?.variant === 'none') return null
  return (
    <Group groupRef={groupRef}>
      {resource.status === 'loading' ? (
        <Loading label={strings.project.consumption.loading} rows={2} />
      ) : drawn === null || drawn.variant === 'unavailable' ? (
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
      ) : (
        <Facts drawn={drawn} />
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
 */
export default function ConsumptionBlock({ projectId, terms }: { projectId: string; terms: Terms | null }) {
  const request = summaryRequestOf(terms)
  if (request === null) {
    const sold = consumptionOf(terms, null)
    return sold.variant === 'package_not_started' ? (
      <Group>
        <Facts drawn={sold} />
      </Group>
    ) : null
  }
  return <SummaryConsumption projectId={projectId} terms={terms} span={request.window} />
}

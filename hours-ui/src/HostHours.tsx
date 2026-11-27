import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Banner, Button, DataTable, FactList, Icon, SkeletonRows, VisuallyHidden } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { Duration } from './components/EntryRow'
import { checkProps, isSummaryAnswer, notesOf, personRows, workTypeRows } from './HostHoursModel'
import type { BreakdownRow, HostHoursProps } from './HostHoursModel'
import { getSummary } from './lib/hoursApi'
import type { SummaryAnswer } from './lib/hoursApi.types'
import { TIME_ENTRY_RECORDED, isTimeEntryRecordedDetail } from './lib/timeEntryRecordedEvent'
import { strings } from './strings'

export type { HostHoursProps } from './HostHoursModel'

/**
 * HostHours — hours-ui's `./HostHours`, the read panel of a project's or a deal's hours that projects-ui's project page and crm-ui's deal
 * page put in their "Hours" card (specs/20261112-project-hours T13; plan D-P4, § API contracts "`hours/HostHours`"; design S3 and § Gap
 * resolutions; AC-1.7, AC-2.1–2.8, AC-4.3, AC-4.9; ADR 20261126-a-figure-set-against-another-owners-figure-… and
 * 20261104-host-extension-federated-panel-through-the-shell). The shell's `HostExtension` renders it for a host with two plain strings
 * (`on`, `targetId`) and nothing comes back: the host decides only whether to show it, hours-api decides what the caller may read.
 *
 * It makes ONE `GET /time-entries/summary` when it mounts and shows, with no click, the TOTAL recorded (every person's hours on the record,
 * the entries on its linked meetings included) and the line that says so. The breakdown is behind a closed disclosure ("Show breakdown",
 * `aria-expanded`/`aria-controls` on a region that stays in the DOM with `hidden`): per work type, and per person only when the answer
 * carries it. Opening it makes no request, since the one answer carried both. It renders text only, never an `href` built from a name; it
 * sums and sorts nothing (every figure and every order is the server's).
 *
 * States, exactly one body in a root that is always mounted: loading (a skeleton row and a polite line, no button yet), loaded, empty (the
 * total reads "0 min" with one sentence and nothing to disclose) and unavailable (a warning with Retry and NO figure: an answer that is
 * not the contract's counts as unavailable too, so a total that did not come never reads "0 min"). A note about the names (`identities`) or
 * about the per-person right (`authz`) sits inside the open region, next to what it explains.
 *
 * It listens, while mounted, for the content-free `operai:time-entry-recorded` event `./RecordHours` broadcasts after a save and, when the
 * event names its own target, reads again from the owner (D84, D-P6): the figures and the open or closed breakdown stay on screen until the
 * answer, the read in flight is restarted rather than duplicated, and a burst of events in one turn is one read. It takes no figure from
 * the event, and ignores another target and a detail that is not exactly the fact. It resets its data and its disclosure when `on` or
 * `targetId` changes, and keeps both across the host's re-renders.
 *
 * It imports `hoursApi`, the strings, `@operai/ui` and the entry list's `Duration` only: never `exceljs`, a page or hours-ui's router,
 * because it renders in a host's tree (`HostHours.graph.test.ts` holds that).
 */
export default function HostHours(props: HostHoursProps): ReactNode {
  // An invalid set is a host bug: it throws here, and the host's boundary shows its own fallback.
  const { on, targetId } = checkProps(props)
  // A different record is a different panel: its data and its disclosure start again, and the old read is dropped with it.
  return <Panel key={`${on}:${targetId}`} on={on} targetId={targetId} />
}

type Read = { status: 'loading' } | { status: 'loaded'; answer: SummaryAnswer } | { status: 'error' }

function Panel({ on, targetId }: HostHoursProps) {
  const t = strings.hostHours
  const root = useRef<HTMLDivElement>(null)
  /** Set by a Retry: the next answer, whatever it is, puts focus on the group (the button that had it is gone). */
  const focusWhenAnswered = useRef(false)
  const [read, setRead] = useState<Read>({ status: 'loading' })
  // The widget's own state: closed on every load, kept across a re-read and a Retry, not in the address.
  const [open, setOpen] = useState(false)
  // Every ask for the same record is one more attempt: the read in flight is dropped, never duplicated.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    getSummary(on, targetId, { signal: controller.signal }).then(
      (answer) => {
        // A read nobody waits for any more is dropped, however late it answers.
        if (!controller.signal.aborted)
          setRead(isSummaryAnswer(answer) ? { status: 'loaded', answer } : { status: 'error' })
      },
      () => {
        if (!controller.signal.aborted) setRead({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [on, targetId, attempt])

  useEffect(() => {
    const onRecorded = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (isTimeEntryRecordedDetail(detail) && detail.on === on && detail.targetId === targetId) {
        // Not a `loading`: what is on screen stays until the new answer replaces it. Several events in one turn batch into one attempt.
        setAttempt((current) => current + 1)
      }
    }
    window.addEventListener(TIME_ENTRY_RECORDED, onRecorded)
    return () => window.removeEventListener(TIME_ENTRY_RECORDED, onRecorded)
  }, [on, targetId])

  useEffect(() => {
    if (read.status === 'loading' || !focusWhenAnswered.current) return
    focusWhenAnswered.current = false
    root.current?.focus()
  }, [read])

  const retry = () => {
    focusWhenAnswered.current = true
    setRead({ status: 'loading' })
    setAttempt((current) => current + 1)
  }

  return (
    <div ref={root} role="group" aria-label={t.regionLabel[on]} tabIndex={-1} data-testid="hours-host-hours">
      {read.status === 'loading' && (
        <>
          <VisuallyHidden live data-testid="hours-host-hours-loading">
            {t.loading}
          </VisuallyHidden>
          <SkeletonRows rows={1} actions={0} />
        </>
      )}
      {read.status === 'error' && (
        <Banner
          tone="warning"
          title={t.error.title}
          onRetry={retry}
          retryLabel={strings.common.retry}
          retryTestId="hours-host-hours-error-retry"
          data-testid="hours-host-hours-error"
        >
          {t.error.body}
        </Banner>
      )}
      {read.status === 'loaded' && (
        <Figures
          on={on}
          answer={read.answer}
          open={open}
          onToggle={() => setOpen((current) => !current)}
          onRetry={retry}
        />
      )}
    </div>
  )
}

const columns = (nameHeader: string): readonly DataTableColumn<BreakdownRow>[] => [
  { id: 'name', header: nameHeader, rowHeader: true, render: (row) => row.label },
  {
    id: 'time',
    header: strings.totals.columnTime,
    numeric: true,
    render: (row) => <Duration minutes={row.minutes} />,
  },
]

type FiguresProps = {
  on: HostHoursProps['on']
  answer: SummaryAnswer
  open: boolean
  onToggle: () => void
  /** Ask again after the per-person right could not be checked. */
  onRetry: () => void
}

/** The total, what it includes and the disclosure (loaded), or the total and a sentence when there is nothing to disclose (empty). */
function Figures({ on, answer, open, onToggle, onRetry }: FiguresProps) {
  const t = strings.hostHours
  const regionId = useId()
  const workTypeHeadingId = useId()
  const personHeadingId = useId()
  const notes = notesOf(answer)
  const workTypes = workTypeRows(answer.byWorkType)
  const people = answer.byPerson === null ? [] : personRows(answer.byPerson)

  return (
    <div className="flex flex-col gap-3">
      <FactList
        testId="hours-host-hours-total"
        items={[{ id: 'total', term: t.total, value: <Duration minutes={answer.totalMinutes} /> }]}
      />
      {answer.totalMinutes === 0 ? (
        <p className="text-sm text-soft" data-testid="hours-host-hours-empty">
          {t.empty[on]}
        </p>
      ) : (
        <>
          <p className="text-xs text-soft">{t.includesMeetings[on]}</p>
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={regionId}
              onClick={onToggle}
              data-testid="hours-host-hours-toggle"
            >
              <Icon name={open ? 'chevron-up' : 'chevron-down'} /> {open ? t.hide : t.show}
            </Button>
          </div>
          {/* Always in the DOM, so `aria-controls` names a real element; `hidden` takes it out of the tab order and the accessibility tree. */}
          <div id={regionId} hidden={!open} data-testid="hours-host-hours-breakdown">
            <div className="flex flex-col gap-4">
              {notes.identities && (
                <Banner tone="info" live="polite" data-testid="hours-host-hours-identities">
                  {strings.entries.banners.unavailable(strings.names.sources.identities)}
                </Banner>
              )}
              {workTypes.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h4 id={workTypeHeadingId} className="text-sm font-semibold text-text">
                    {t.byWorkType.heading}
                  </h4>
                  <DataTable
                    caption={t.byWorkType.caption}
                    labelledBy={workTypeHeadingId}
                    columns={columns(t.byWorkType.column)}
                    rows={workTypes}
                    getRowKey={(row) => row.key}
                    testId="hours-host-hours-work-types"
                  />
                </section>
              )}
              {notes.authz && (
                <Banner
                  tone="info"
                  live="polite"
                  onRetry={onRetry}
                  retryLabel={strings.common.retry}
                  retryTestId="hours-host-hours-people-retry"
                  data-testid="hours-host-hours-people-unavailable"
                >
                  {t.peopleUnavailable}
                </Banner>
              )}
              {people.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h4 id={personHeadingId} className="text-sm font-semibold text-text">
                    {t.byPerson.heading}
                  </h4>
                  <DataTable
                    caption={strings.totals.caption.person}
                    labelledBy={personHeadingId}
                    columns={columns(strings.totals.groupBy.person)}
                    rows={people}
                    getRowKey={(row) => row.key}
                    testId="hours-host-hours-people"
                  />
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

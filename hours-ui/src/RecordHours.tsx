import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Banner, Button } from '@operai/ui'
import { navigateSuite } from 'shell/session'
import EntryDialog from './components/EntryDialog'
import type { EntryDialogLists } from './components/EntryDialog'
import { durationText } from './components/EntryDialogModel'
import { createEntry, getTimeLists } from './lib/hoursApi'
import type { EntryInput } from './lib/hoursApi.types'
import { TIME_ENTRY_RECORDED } from './lib/timeEntryRecordedEvent'
import type { TimeEntryRecordedDetail } from './lib/timeEntryRecordedEvent'
import { MY_HOURS_PATH, checkProps, presetOf } from './RecordHoursModel'
import type { RecordHoursProps } from './RecordHoursModel'
import { strings } from './strings'

export type { RecordHoursProps } from './RecordHoursModel'

/** A plain click goes through the shell's router; a modified one (new tab, new window, download) is left to the browser. */
const isPlainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.defaultPrevented && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)

/**
 * RecordHours — hours-ui's `./RecordHours`, the button other tools put on a project page, a deal page and a task row
 * (specs/20261116-record-hours-in-place T2; ADR 20261116-record-hours-widget-through-the-host-extension-seam; plan Decision 2, § API
 * contracts "`hours/RecordHours`"; design S1–S5). The shell's `HostExtension` renders it for a host with six plain strings
 * and nothing comes back: the host decides only whether to offer it, this owns the dialog, the write and the message
 * after it, so "nothing else on the page changes" (AC-4.3) needs no callback.
 *
 * It opens My hours' own `EntryDialog` on the project, deal or task the host named, fixed, with today as the day and the
 * keyboard on Duration, and records through the unchanged `POST /time-entries` as the person: hours-api decides every save,
 * failing closed (`not_on_project`, `not_involved_in_deal`, `host_unavailable`), and the dialog words every refusal as it
 * does in My hours. The categories and work types are read when the button is pressed (a long task list mounts many of
 * these, and none reads anything until it is used), and the dialog opens once they have answered, or failed: a failure is
 * the dialog's own "could not be loaded" with Try again, and a project or deal entry still saves without a work type.
 *
 * It never edits, never deletes, reads no entries and checks no permission (`useHoursAccess` is not used): an entry is
 * changed only in My hours (AC-4.4). After a save the dialog closes and a `role="status"` message says what was recorded,
 * with a link to My hours through `navigateSuite`. The message has no timer (G1): a link that vanished in three seconds
 * could not be reached from the keyboard (WCAG 2.2.1). It goes by ×, by the next save, or by leaving the page.
 *
 * After a save that stood it also broadcasts ONE content-free `operai:time-entry-recorded` event on `window`, naming only the
 * project or deal it recorded on (a task row: the task's project or deal; other work: none), so a panel on the same page that
 * shows that target's figures can read them again from their owner (specs/20261112-project-hours T10, D84, D-P6; ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam, amended 2026-11-26). It is still not a callback: nothing comes back
 * to the host, a host that does not listen is unchanged, and a refused or failed save sends nothing.
 *
 * It imports only `EntryDialog`, `hoursApi`, `searchers`, the event's name and the strings, so the chunk a host loads carries none
 * of the pages and not `exceljs` (plan R3; `RecordHours.graph.test.ts` holds that).
 */
export default function RecordHours(props: RecordHoursProps): ReactNode {
  // An invalid set is a host bug: it throws here, and the host's boundary shows its fallback link.
  return <RecordHoursButton {...checkProps(props)} />
}

function RecordHoursButton(props: RecordHoursProps) {
  const { on, targetId, targetName, activityName, placement } = props
  const t = strings.recordHours
  const button = useRef<HTMLButtonElement>(null)
  const read = useRef<AbortController | null>(null)
  // The dialog is open while `lists` is not null; the button is busy while the first read has not answered.
  const [reading, setReading] = useState(false)
  const [lists, setLists] = useState<EntryDialogLists | null>(null)
  const [recorded, setRecorded] = useState<string | null>(null)

  // A read nobody waits for any more is dropped, however late it answers.
  useEffect(() => () => read.current?.abort(), [])

  /** The lists as the dialog takes them: what was read, or that it could not be. */
  const readLists = async (): Promise<EntryDialogLists | null> => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    try {
      const answer = await getTimeLists({ includeRetired: true, signal: controller.signal })
      return controller.signal.aborted ? null : { status: 'loaded', lists: answer }
    } catch {
      return controller.signal.aborted ? null : { status: 'error' }
    }
  }

  const start = async () => {
    // A mouse click does not focus a button in every browser, and the dialog gives focus back to whatever had it.
    button.current?.focus()
    setReading(true)
    const answer = await readLists()
    setReading(false)
    if (answer !== null) setLists(answer)
  }

  const reload = async () => {
    setLists({ status: 'loading' })
    const answer = await readLists()
    if (answer !== null) setLists(answer)
  }

  /** Closes the dialog (cancelled, or saved). A read still on its way is dropped, or it would open the dialog again. */
  const close = () => {
    read.current?.abort()
    setLists(null)
  }

  /** What was recorded, in the person's words: where, and for other work the category (named by the lists the dialog offered). */
  const sentenceOf = (input: EntryInput, categories: readonly { id: string; name: string }[]): string => {
    const duration = durationText(input.minutes)
    if (input.on.type === 'none') {
      const categoryId = input.on.categoryId
      return t.recordedOther(duration, categories.find((category) => category.id === categoryId)?.name ?? '')
    }
    const named = targetName.trim() === '' ? (on === 'deal' ? t.thisDeal : t.thisProject) : targetName
    return t.recorded(duration, named)
  }

  const submit = async (input: EntryInput) => {
    await createEntry(input)
    setRecorded(sentenceOf(input, lists?.status === 'loaded' ? lists.lists.categories : []))
    close()
    // Only now: a refused or failed save threw above, so no panel is told of hours that were not recorded. The fact is the target and
    // nothing else (D-P6); the figures are read again by whoever shows them, from their owner, never taken from this.
    const detail: TimeEntryRecordedDetail = on === 'none' ? { on, targetId: '' } : { on, targetId }
    window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail }))
  }

  const dismiss = () => {
    setRecorded(null)
    button.current?.focus()
  }

  const message =
    recorded === null ? null : (
      <Banner
        tone="success"
        compact
        onDismiss={dismiss}
        dismissLabel={strings.common.dismiss}
        dismissTestId="hours-record-hours-dismiss"
        className={placement === 'page' ? 'max-w-sm' : 'basis-full'}
        data-testid="hours-record-hours-message"
      >
        {/* The name is the host's record's (up to 200 characters, no break in it) and the message sits in the host's header, whose
            width is what is left of the window. `wrap-anywhere`, not `break-words`: the box is shrunk to that width by its
            ancestors' minimum content, which only `anywhere` lowers, so a long name no longer holds the box at its cap past a
            phone's edge and across the button it answers; an ordinary name still wraps at its spaces (QE pass 4 D1). */}
        <span className="wrap-anywhere" data-testid="hours-record-hours-recorded">
          {recorded}
        </span>{' '}
        <a
          className="link"
          href={MY_HOURS_PATH}
          onClick={(event) => {
            if (!isPlainClick(event)) return
            event.preventDefault()
            navigateSuite(MY_HOURS_PATH)
          }}
          data-testid="hours-record-hours-link"
        >
          {t.seeInMyHours}
        </a>
      </Banner>
    )

  const trigger = (
    <Button
      ref={button}
      variant="secondary"
      size={placement === 'row' ? 'sm' : 'md'}
      busy={reading}
      aria-haspopup="dialog"
      aria-label={activityName === '' ? undefined : t.buttonOn(activityName)}
      onClick={() => void start()}
      data-testid="hours-record-hours"
    >
      {strings.entry.record}
    </Button>
  )

  return (
    <>
      {/* On a page the message sits just before the button it answers; on a row, last, on its own line. */}
      {placement === 'page' && message}
      {trigger}
      {placement === 'row' && message}
      {lists !== null && (
        <EntryDialog
          lists={lists}
          onReloadLists={() => void reload()}
          onSubmit={submit}
          onCancel={close}
          preset={presetOf(props)}
          fixed
          focus="duration"
        />
      )}
    </>
  )
}

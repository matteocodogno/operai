import { useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'
import DeviceCard from '../components/DeviceCard'
import ErrorBanner from '../components/ErrorBanner'
import SkeletonListRows from '../components/SkeletonListRows'
import { ApiError } from '../lib/api'
import { confirmAssignment, declineAssignment, getMyDevices } from '../lib/meApi'
import type { MyDevice, MyDevicesResponse, MyPending } from '../lib/types'
import { strings } from '../strings'

/**
 * MyDevicesPage — D1, the employee's own devices (T31, specs/015-hardware-
 * inventory; design.md § D1, F14, Q3 as resolved; AC-2.3, AC-2.4, AC-4.1,
 * AC-4.2, AC-4.4). Mounted at the UNGATED `/devices` (ADR-0045), so it works for
 * a user with no grant at all: it reads only `meApi`, never `GET /scope` and no
 * capability hook, and it uses the `MyDevice` types, never `AssetView`, so there
 * is no price, currency, entity or book value for it to show (AC-4.2).
 *
 * Sections: "Waiting for your confirmation" (omitted when empty) and "Devices I
 * hold"; nothing at all is the explicit empty state. Confirm is one click;
 * Decline opens a confirm dialog first (Q3). Focus after an action (design §
 * Accessibility D1): after Confirm, the heading of the card that just appeared
 * under "Devices I hold"; after Decline, the next pending card's heading, else
 * the page heading; a failed action stays on the card, whose inline alert says
 * why. A card that went stale (404 or `assignment_not_pending`) shows a page
 * notice and the list is refreshed in place.
 */

type Outcome = { attempt: number; ok: true; data: MyDevicesResponse } | { attempt: number; ok: false; error: unknown }

/** `'page'` is the page heading; anything else is a device's `assetId`. */
const PAGE_HEADING = 'page'

const isStale = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.code === 'assignment_not_pending')

export default function MyDevicesPage() {
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cardError, setCardError] = useState<{ assignmentId: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('')
  const [declining, setDeclining] = useState<{ pending: MyPending; busy: boolean; error: string | null } | null>(null)

  const inFlight = useRef(false)
  const pendingFocus = useRef<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const alive = useRef(new AbortController())

  useEffect(() => {
    const controller = new AbortController()
    alive.current = controller
    getMyDevices({ signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setOutcome({ attempt, ok: true, data })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ attempt, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [attempt])

  // Move focus once the element exists; an unmatched target waits for the render that adds it.
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    const element =
      target === PAGE_HEADING
        ? headingRef.current
        : Array.from(document.querySelectorAll<HTMLElement>('[data-device-heading]')).find(
            (heading) => heading.dataset.deviceHeading === target,
          )
    if (element) {
      pendingFocus.current = null
      element.focus()
    }
  })

  const current = outcome?.attempt === attempt ? outcome : null
  const data = current?.ok ? current.data : null
  const fetchError = current !== null && !current.ok ? current.error : null

  /** Replaces the list in place after a stale card, without a skeleton. */
  const refresh = () => {
    getMyDevices({ signal: alive.current.signal }).then(
      (fresh) => {
        if (!alive.current.signal.aborted) setOutcome({ attempt, ok: true, data: fresh })
      },
      () => undefined,
    )
  }

  const update = (change: (previous: MyDevicesResponse) => MyDevicesResponse) =>
    setOutcome((previous) => (previous?.ok ? { ...previous, data: change(previous.data) } : previous))

  const goStale = () => {
    setNotice(strings.myDevices.noLongerOpen)
    pendingFocus.current = PAGE_HEADING
    refresh()
  }

  const confirm = async (item: MyPending) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusyId(item.assignmentId)
    setNotice(null)
    setCardError(null)
    try {
      const { device } = await confirmAssignment(item.assignmentId)
      pendingFocus.current = device.assetId
      update((previous) => ({
        pending: previous.pending.filter((p) => p.assignmentId !== item.assignmentId),
        devices: [device, ...previous.devices.filter((d) => d.assetId !== device.assetId)],
      }))
      setStatusLine(strings.myDevices.confirmed(item.description))
    } catch (error) {
      if (isStale(error)) goStale()
      else setCardError({ assignmentId: item.assignmentId, message: strings.myDevices.card.confirmFailed })
    } finally {
      inFlight.current = false
      setBusyId(null)
    }
  }

  const decline = async (item: MyPending) => {
    if (inFlight.current || data === null) return
    inFlight.current = true
    setNotice(null)
    setDeclining({ pending: item, busy: true, error: null })
    const index = data.pending.findIndex((p) => p.assignmentId === item.assignmentId)
    const next = index >= 0 ? data.pending[index + 1] : undefined
    try {
      await declineAssignment(item.assignmentId)
      pendingFocus.current = next?.assetId ?? PAGE_HEADING
      update((previous) => ({
        ...previous,
        pending: previous.pending.filter((p) => p.assignmentId !== item.assignmentId),
      }))
      setStatusLine(strings.myDevices.declined(item.description))
      setDeclining(null)
    } catch (error) {
      if (isStale(error)) {
        setDeclining(null)
        goStale()
      } else {
        setDeclining({ pending: item, busy: false, error: strings.myDevices.declineDialog.failed })
      }
    } finally {
      inFlight.current = false
    }
  }

  const t = strings.myDevices
  const devices: MyDevice[] = data?.devices ?? []
  const waiting: MyPending[] = data?.pending ?? []

  return (
    <section
      aria-labelledby="devices-heading"
      data-testid="inventory-my-devices-page"
      className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8"
    >
      <h1
        id="devices-heading"
        ref={headingRef}
        tabIndex={-1}
        data-testid="devices-heading"
        className="text-lg font-semibold focus:outline-none focus-visible:ring-2"
        style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
      >
        {t.heading}
      </h1>

      <p role="status" aria-live="polite" data-testid="devices-status" className="sr-only">
        {statusLine}
      </p>

      {notice !== null && (
        <p
          role="alert"
          data-testid="devices-notice"
          className="rounded-md border px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--org)',
            backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
            color: 'var(--org)',
          }}
        >
          {notice}
        </p>
      )}

      {fetchError !== null ? (
        <ErrorBanner
          message={
            fetchError instanceof ApiError ? (fetchError.detail ?? strings.errors.unknown) : strings.errors.network
          }
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : data === null ? (
        <div>
          <p role="status" aria-live="polite" className="sr-only" data-testid="devices-loading">
            {t.loading}
          </p>
          <SkeletonListRows />
        </div>
      ) : waiting.length === 0 && devices.length === 0 ? (
        <p data-testid="devices-empty" className="text-sm" style={{ color: 'var(--soft)' }}>
          {t.empty}
        </p>
      ) : (
        <>
          {waiting.length > 0 && (
            <section aria-labelledby="devices-pending-heading" className="flex flex-col gap-3">
              <h2
                id="devices-pending-heading"
                className="text-base font-semibold"
                style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
              >
                {t.pendingHeading(waiting.length)}
              </h2>
              <ul className="flex flex-col gap-2">
                {waiting.map((item) => (
                  <DeviceCard
                    key={item.assignmentId}
                    device={item}
                    kind="pending"
                    busy={busyId === item.assignmentId}
                    errorMessage={cardError?.assignmentId === item.assignmentId ? cardError.message : null}
                    onConfirm={() => void confirm(item)}
                    onDecline={() => {
                      setCardError(null)
                      setDeclining({ pending: item, busy: false, error: null })
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="devices-held-heading" className="flex flex-col gap-3">
            <h2
              id="devices-held-heading"
              className="text-base font-semibold"
              style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
            >
              {t.heldHeading(devices.length)}
            </h2>
            {devices.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--soft)' }}>
                {t.heldEmpty}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {devices.map((device) => (
                  <DeviceCard key={device.assetId} device={device} kind="held" />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {declining !== null && (
        <ConfirmDialog
          entityLabel={t.declineDialog.entityLabel}
          itemName={declining.pending.description}
          isDeleting={declining.busy}
          errorMessage={declining.error}
          title={t.declineDialog.title(declining.pending.description)}
          body={<p>{t.declineDialog.body}</p>}
          confirmLabel={t.declineDialog.confirm}
          confirmingLabel={t.declineDialog.confirming}
          onConfirm={() => void decline(declining.pending)}
          onCancel={() => setDeclining(null)}
          testIdPrefix="decline-assignment"
        />
      )}
    </section>
  )
}

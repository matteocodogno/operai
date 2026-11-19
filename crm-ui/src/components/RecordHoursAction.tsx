import { Component, useEffect, useState } from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'
import type { RecordHoursProps } from '../lib/recordHours'
import { strings } from '../strings'

type HostExtensionComponent = typeof import('shell/extensions').HostExtension

type Seam = { status: 'loading' } | { status: 'ready'; HostExtension: HostExtensionComponent } | { status: 'failed' }

const LOADING: Seam = { status: 'loading' }

/**
 * The outcome of importing `shell/extensions`, kept for the life of the page: a list of tasks mounts one of these per
 * row the person may record on, and they must share one import, not repeat it (plan R1). A failed import is kept too:
 * the browser caches it, so a retry would only fail again and the fallback link is the whole offer (the
 * `MeetingsSection` posture).
 */
let loaded: Seam | null = null
let loading: Promise<Seam> | null = null

function loadSeam(): Promise<Seam> {
  loading ??= import('shell/extensions')
    .then(
      (module): Seam => {
        try {
          // Reading the export is inside the try: a module namespace can throw on access.
          const HostExtension = (module as { HostExtension?: ComponentType<never> }).HostExtension
          return typeof HostExtension === 'function'
            ? { status: 'ready', HostExtension: HostExtension as unknown as HostExtensionComponent }
            : { status: 'failed' }
        } catch {
          return { status: 'failed' }
        }
      },
      (): Seam => ({ status: 'failed' }),
    )
    .then((seam) => {
      loaded = seam
      return seam
    })
  return loading
}

function useSeam(): Seam {
  const [seam, setSeam] = useState<Seam>(loaded ?? LOADING)
  useEffect(() => {
    let live = true
    void loadSeam().then((next) => {
      if (live) setSeam(next)
    })
    return () => {
      live = false
    }
  }, [])
  return seam
}

/**
 * The host's own fallback (design S5): a plain link to My hours where the button would have been. A real anchor, so it
 * works with the widget gone; when hours-ui is down it lands on the shell's own remote-failure state, the right place
 * to retry.
 */
function FallbackLink({ placement }: { placement: RecordHoursProps['placement'] }) {
  return (
    <a
      href="/hours"
      className={placement === 'row' ? 'link self-center text-sm' : 'link text-sm'}
      data-testid="crm-record-hours-fallback"
    >
      {strings.recordHours.fallbackLink}
    </a>
  )
}

/**
 * `shell/extensions` promises never to throw (ADR 20260803-suite-version-generated-file-federated-export), but this seam runs
 * across a deploy boundary, so the page does not rely on it: a render-time throw anywhere under the widget is contained
 * to the link that takes its place.
 */
class Contain extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('crm-ui: Record hours failed to render', error, info.componentStack)
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * RecordHoursAction — Record hours on a CRM page or row (specs/20261116-record-hours-in-place AC-4.5; ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam). The button, its dialog and its message are hours-ui's
 * own, a federated widget loaded through the shell's `shell/extensions` seam as `hours.recordHours`
 * (ADR 20261104-host-extension-federated-panel-through-the-shell): this wrapper only imports the seam, hands it six plain strings
 * and keeps the host's fallback. The caller decides WHETHER to render it (`mayRecordOn…`); hours-api decides every save.
 *
 * Nothing shows while the widget loads, then the button; a shell that predates the extension, a failing import, a
 * module without `HostExtension`, a widget that throws, or one that does not answer in 5 s shows a link to My hours
 * instead (the shell's `HostExtension` supplies the last two), and the rest of the page is unaffected.
 *
 * Props come from `recordHoursPropsOf…` in `lib/recordHours.ts`, built from one object so the name shown and the id
 * recorded on belong together (plan R10); they cross the seam as exactly these six strings.
 */
export default function RecordHoursAction({
  on,
  targetId,
  targetName,
  activityId,
  activityName,
  placement,
}: RecordHoursProps) {
  const seam = useSeam()
  if (seam.status === 'loading') return null
  const fallback = <FallbackLink placement={placement} />
  if (seam.status === 'failed') return fallback
  const { HostExtension } = seam
  const props: RecordHoursProps = { on, targetId, targetName, activityId, activityName, placement }
  return (
    // Keyed like the shell keys its own boundary: a throw for one target must not blank the next one.
    <Contain key={JSON.stringify(props)} fallback={fallback}>
      <HostExtension name="hours.recordHours" props={props} fallback={fallback} />
    </Contain>
  )
}

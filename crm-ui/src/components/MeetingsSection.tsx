import { Component, useEffect, useState } from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'
import { Banner, Card } from '@operai/ui'
import { strings } from '../strings'
import { Loading } from './LoadState'

type HostExtensionComponent = typeof import('shell/extensions').HostExtension

type Seam = { status: 'loading' } | { status: 'ready'; HostExtension: HostExtensionComponent } | { status: 'failed' }

/** The host's own card: the section keeps its heading whatever happens to the remote (AC-11.6). */
function MeetingsCard({ children }: { children: ReactNode }) {
  return (
    <Card title={strings.deals.meetings.heading} data-testid="crm-deal-meetings">
      {children}
    </Card>
  )
}

const unavailable = (
  <MeetingsCard>
    <Banner tone="info" data-testid="crm-deal-meetings-unavailable">
      {strings.deals.meetings.unavailable}
    </Banner>
  </MeetingsCard>
)

const loadingCard = (
  <MeetingsCard>
    <Loading label={strings.deals.meetings.loading} rows={2} />
  </MeetingsCard>
)

/**
 * `shell/extensions` promises never to throw (ADR-0030), but this seam runs
 * across a deploy boundary, so the deal page does not rely on it: a render-time
 * throw anywhere under the panel is contained to the Meetings card.
 */
class Contain extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('crm-ui: the Meetings section failed to render', error, info.componentStack)
  }

  override render() {
    return this.state.failed ? unavailable : this.props.children
  }
}

/**
 * MeetingsSection — the "Meetings" card of the deal page (specs/021 AC-11.2).
 * The panel is Meetings' own, a federated component loaded through the shell's
 * `shell/extensions` seam with `{hostApp:'crm', entityType:'deal', entityId}`
 * (ADR-0060). crm-ui imports the seam dynamically: a shell that predates the
 * expose, a failing import or a module without `HostExtension` renders this
 * card's own fallback with the same heading, and the rest of the page is
 * unaffected (AC-11.6, ADR-0030). No retry: a failed module import is cached,
 * so the fallback says to reload the page.
 *
 * Deals only: the company page rolls up no meetings in this release (AC-11.7).
 */
export default function MeetingsSection({ dealId }: { dealId: string }) {
  const [seam, setSeam] = useState<Seam>({ status: 'loading' })

  useEffect(() => {
    let live = true
    import('shell/extensions').then(
      (module) => {
        if (!live) return
        try {
          // Reading the export is inside the try: a module namespace can throw on access.
          const HostExtension = (module as { HostExtension?: ComponentType<never> }).HostExtension
          setSeam(
            typeof HostExtension === 'function'
              ? { status: 'ready', HostExtension: HostExtension as unknown as HostExtensionComponent }
              : { status: 'failed' },
          )
        } catch {
          setSeam({ status: 'failed' })
        }
      },
      () => {
        if (live) setSeam({ status: 'failed' })
      },
    )
    return () => {
      live = false
    }
  }, [])

  if (seam.status === 'loading') return loadingCard
  if (seam.status === 'failed') return unavailable
  const { HostExtension } = seam
  return (
    <Contain>
      <HostExtension
        name="meetings.hostMeetings"
        props={{ hostApp: 'crm', entityType: 'deal', entityId: dealId }}
        fallback={unavailable}
        loading={loadingCard}
      />
    </Contain>
  )
}

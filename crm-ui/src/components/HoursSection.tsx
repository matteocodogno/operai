import { Banner, Card } from '@operai/ui'
import { strings } from '../strings'
import { Loading } from './LoadState'
import { useExtensionSeam } from '../lib/extensionSeam'
import ExtensionContain from './ExtensionContain'

const unavailable = (
  <Banner tone="info" data-testid="crm-deal-hours-unavailable">
    {strings.deals.hours.unavailable}
  </Banner>
)

/**
 * HoursSection — the ONE "Hours" card of the deal page (specs/20261112-project-hours AC-2.2, AC-2.4, AC-2.6, design S2).
 * The panel is hours-ui's own read panel (the total recorded, and behind a closed disclosure the breakdown per work type
 * and, for the deal's owner or a holder of see everyone's hours, per person), a federated component loaded through the
 * shell's `shell/extensions` seam as `hours.hostHours` with `{ on: 'deal', targetId }` and nothing else
 * (ADR 20261104-host-extension-federated-panel-through-the-shell, plan D-P4). The card holds the panel alone: the deal
 * has no consumption to set it against.
 *
 * Unlike `MeetingsSection`, which swaps a whole card for its fallback, this section owns the card: the frame and its
 * title are drawn in every state, and only the slot inside changes — the loading line, the panel, or the host's own
 * "Hours are unavailable" notice. A shell that predates the expose, a failing import, a module without `HostExtension`,
 * a widget that throws or one that does not answer in 5 s all end at that notice, and the rest of the page is
 * unaffected (AC-2.6, ADR 20260803-suite-version-generated-file-federated-export). No retry: a failed module import is
 * cached, so the notice says to reload the page; the panel's own failures (hours-api down) have their own Retry.
 *
 * Whether the person may see the deal's hours is hours-api's answer as the caller; this host checks no permission.
 */
export default function HoursSection({ dealId }: { dealId: string }) {
  const seam = useExtensionSeam()
  return (
    <Card title={strings.deals.hours.heading} data-testid="crm-deal-hours">
      {seam.status === 'loading' ? (
        <Loading label={strings.deals.hours.loading} rows={1} />
      ) : seam.status === 'failed' ? (
        unavailable
      ) : (
        <ExtensionContain widget="the Hours section" resetKey={dealId} fallback={unavailable}>
          <seam.HostExtension
            name="hours.hostHours"
            props={{ on: 'deal', targetId: dealId }}
            fallback={unavailable}
            loading={<Loading label={strings.deals.hours.loading} rows={1} />}
            resetKey={dealId}
          />
        </ExtensionContain>
      )}
    </Card>
  )
}
